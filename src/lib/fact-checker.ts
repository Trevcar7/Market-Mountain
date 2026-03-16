import { FactCheckResult } from "./news-types";

// ---------------------------------------------------------------------------
// Google Fact Check Tools API response shape
// https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search
// ---------------------------------------------------------------------------

interface GoogleClaimReview {
  url?: string;
  textualRating?: string;
  languageCode?: string;
}

interface GoogleClaim {
  claimReview?: GoogleClaimReview[];
}

interface GoogleFactCheckResponse {
  claims?: GoogleClaim[];
}

/**
 * Extract verifiable claims/facts from synthesized story text.
 *
 * IMPORTANT: Pass only the parsed story body — NOT raw Claude output.
 * Raw output contains HEADLINE:, KEY_TAKEAWAYS:, etc. prefixes that
 * produce garbage claims and inflated scores.
 */
export function extractClaimsFromStory(story: string): string[] {
  // Strip any residual structured output prefixes (defensive)
  const cleaned = story
    .replace(/^(HEADLINE|KEY_TAKEAWAYS|WHY_MATTERS|SECOND_ORDER|WHAT_WATCH|MARKET_IMPACT):\s*/gm, "")
    .replace(/^[•\-\*]\s*/gm, "");

  const claims: string[] = [];

  // Split into sentences — handle both period-terminated and newline-separated.
  // Protect decimal points (e.g. 0.7%, $2.1B, 4.28%) so they are not treated
  // as sentence terminators by the regex.
  const withProtectedDecimals = cleaned.replace(/(\d)\.(\d)/g, "$1\x00$2");
  const sentences = (withProtectedDecimals.match(/[^.!?\n]+[.!?]+/g) || [])
    .map((s) => s.replace(/\x00/g, "."));

  // Opinion/prediction filters — claims containing these are unverifiable
  const OPINION_PATTERNS = [
    "I think", "should", "may ", "could ", "might ",
    "appears to be", "likely", "unlikely", "expected to",
    "analysts believe", "experts suggest", "projected to",
    "would ", "in our view", "arguably",
  ];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();

    if (
      trimmed.length > 30 &&
      !OPINION_PATTERNS.some((p) => trimmed.toLowerCase().includes(p.toLowerCase()))
    ) {
      // Prefer claims with concrete data — prioritize sentences with numbers
      const words = trimmed.split(" ");
      const claim = words.slice(0, Math.min(25, words.length)).join(" ");
      claims.push(claim);
    }
  }

  // Prioritize claims containing numbers (more verifiable)
  claims.sort((a, b) => {
    const aHasNum = /\d/.test(a) ? 1 : 0;
    const bHasNum = /\d/.test(b) ? 1 : 0;
    return bHasNum - aHasNum;
  });

  return claims.slice(0, 5);
}

/**
 * Verify claims using Google Fact Check API
 * Returns confidence score for overall story accuracy
 */
export async function verifyClaims(claims: string[]): Promise<{
  results: FactCheckResult[];
  overallScore: number;
}> {
  if (!claims || claims.length === 0) {
    // Zero extractable claims is suspicious — may indicate formatting issues
    // or content too vague to verify. Score below threshold to flag for review.
    return { results: [], overallScore: 35 };
  }

  const results: FactCheckResult[] = [];
  const googleFactCheckApiKey = process.env.GOOGLE_FACT_CHECK_API_KEY;

  for (const claim of claims) {
    try {
      // Use Google Fact Check API only if key is configured
      if (!googleFactCheckApiKey) {
        results.push(heuristicFactCheck(claim));
        continue;
      }

      const url = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
      url.searchParams.set("key", googleFactCheckApiKey);
      url.searchParams.set("query", claim);

      const response = await fetch(url.toString());

      if (!response.ok) {
        // If API fails, use heuristic fact-check
        results.push(heuristicFactCheck(claim));
        continue;
      }

      const data = (await response.json()) as GoogleFactCheckResponse;
      const claims_data = data.claims ?? [];

      if (claims_data.length > 0) {
        // Check if Google found verification
        const topClaim = claims_data[0];
        const rating = topClaim.claimReview?.[0]?.textualRating ?? "UNKNOWN";

        const verified =
          rating === "TRUE" || rating === "MOSTLY_TRUE" || rating === "SUPPORTED";

        results.push({
          claim,
          verified,
          confidence: verified ? 90 : 30,
          sources: topClaim.claimReview?.map((r: GoogleClaimReview) => r.url ?? "") ?? [],
          explanation: topClaim.claimReview?.[0]?.languageCode,
        });
      } else {
        // No fact-check found - use heuristic
        results.push(heuristicFactCheck(claim));
      }
    } catch (error) {
      console.error(`Fact-check error for claim "${claim}":`, error);
      // On error, use heuristic check
      results.push(heuristicFactCheck(claim));
    }
  }

  // Calculate overall score
  const overallScore =
    results.length > 0
      ? Math.round(
          results.reduce((sum, r) => sum + (r.verified ? r.confidence : 20), 0) /
            results.length
        )
      : 50;

  return { results, overallScore };
}

/**
 * Keyword-based plausibility scorer (NOT real fact-checking).
 * Used as a fallback when the Google Fact Check API key is not configured.
 * Assigns higher scores to claims containing financial terms ($, %, reported)
 * and lower scores to claims with absolutist language (always, never, 100%).
 * Treat the output as a rough writing-quality signal, not a truth assessment.
 */
function heuristicFactCheck(claim: string): FactCheckResult {
  const lowerClaim = claim.toLowerCase();

  // Red flags for false claims
  const redFlags = [
    "all",
    "always",
    "never",
    "100%",
    "guaranteed",
    "impossible",
    "everyone",
    "nobody",
  ];

  const hasRedFlag = redFlags.some((flag) => lowerClaim.includes(flag));

  // Green flags for credible claims
  const greenFlags = [
    "%",
    "$",
    "billion",
    "million",
    "report",
    "data",
    "analysis",
    "research",
  ];

  const hasGreenFlag = greenFlags.some((flag) => lowerClaim.includes(flag));

  // Simple confidence calculation
  let confidence = 50;
  if (hasRedFlag) confidence -= 20;
  if (hasGreenFlag) confidence += 20;

  // Specific financial terms boost confidence
  if (
    lowerClaim.includes("fed") ||
    lowerClaim.includes("rate") ||
    lowerClaim.includes("earnings") ||
    lowerClaim.includes("reported")
  ) {
    confidence += 10;
  }

  return {
    claim,
    verified: confidence >= 65,
    confidence: Math.max(20, Math.min(95, confidence)),
    explanation: "Keyword plausibility score (no external verification)",
  };
}

/**
 * Score fact-check results
 * Returns 0-100 confidence that story is accurate
 */
export function scoreFactCheckResult(results: FactCheckResult[]): number {
  if (results.length === 0) return 40; // No claims = cannot verify = low score

  const verifiedCount = results.filter((r) => r.verified).length;
  const avgConfidence = Math.round(
    results.reduce((sum, r) => sum + r.confidence, 0) / results.length
  );

  // If >80% of claims verified, high confidence; if <50%, low confidence
  if (verifiedCount / results.length > 0.8) {
    return Math.min(100, avgConfidence + 10);
  } else if (verifiedCount / results.length < 0.5) {
    return Math.max(0, avgConfidence - 20);
  }

  return avgConfidence;
}

/**
 * Reject story if fact-check fails
 * Returns true if story should be rejected
 */
export function shouldRejectStory(factCheckScore: number, threshold = 75): boolean {
  return factCheckScore < threshold;
}

/**
 * Log rejected stories for debugging and improvement
 */
export function logRejection(
  title: string,
  reason: string,
  factCheckScore: number
): void {
  console.warn(`[REJECTED] "${title}" - Score: ${factCheckScore} - Reason: ${reason}`);

  // Could also write to file or external logging service
  // fs.appendFileSync('rejected-news.log', `${new Date().toISOString()} | ${title} | ${reason}\n`);
}
