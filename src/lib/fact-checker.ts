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
  let cleaned = story
    .replace(/^(HEADLINE|KEY_TAKEAWAYS|WHY_MATTERS|SECOND_ORDER|WHAT_WATCH|MARKET_IMPACT):\s*/gm, "")
    .replace(/^[•\-\*]\s*/gm, "");

  // Strip section headings (## ...) — these are structural, not claims
  cleaned = cleaned.replace(/^## .+$/gm, "");

  const claims: string[] = [];

  // Split into sentences — handle both period-terminated and newline-separated.
  // Protect decimal points (e.g. 0.7%, $2.1B, 4.28%) so they are not treated
  // as sentence terminators by the regex.
  // Also protect abbreviations like "U.S." and "Corp."
  const withProtectedDecimals = cleaned
    .replace(/(\d)\.(\d)/g, "$1\x00$2")
    .replace(/\bU\.S\./g, "U\x00S\x00")
    .replace(/\bCorp\./g, "Corp\x00")
    .replace(/\bInc\./g, "Inc\x00")
    .replace(/\bLtd\./g, "Ltd\x00")
    .replace(/\bDr\./g, "Dr\x00")
    .replace(/\bSt\./g, "St\x00");
  const sentences = (withProtectedDecimals.match(/[^.!?\n]+[.!?]+/g) || [])
    .map((s) => s.replace(/\x00/g, "."));

  // Opinion/prediction filters — claims containing these are unverifiable
  const OPINION_PATTERNS = [
    "I think", "should", "may ", "could ", "might ",
    "appears to be", "likely", "unlikely", "expected to",
    "analysts believe", "experts suggest", "projected to",
    "would ", "in our view", "arguably", "appears to",
    "suggests that", "could weigh", "may compress",
  ];

  // Quality filters — reject sentences that are too generic or structural
  const GENERIC_PATTERNS = [
    /^(the|this|that|these|those|it)\s+(is|was|are|were)\s+(a|an|the)\s/i,
    /\b(investors|traders|markets)\s+(should|will|are)\s+(watch|monitor|keep an eye)\b/i,
    /\b(remains to be seen|time will tell|only time)\b/i,
  ];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();

    if (
      trimmed.length > 40 &&
      !OPINION_PATTERNS.some((p) => trimmed.toLowerCase().includes(p.toLowerCase())) &&
      !GENERIC_PATTERNS.some((p) => p.test(trimmed))
    ) {
      // Clean up the claim for display — remove trailing fragments
      const words = trimmed.split(" ");
      const claim = words.slice(0, Math.min(30, words.length)).join(" ");
      // Only include if claim still ends cleanly
      const cleanClaim = claim.replace(/[,;:\s]+$/, "").trim();
      if (cleanClaim.length > 30) {
        claims.push(cleanClaim);
      }
    }
  }

  // Prioritize claims containing specific financial data (most verifiable)
  claims.sort((a, b) => {
    const aScore = claimSpecificityScore(a);
    const bScore = claimSpecificityScore(b);
    return bScore - aScore;
  });

  return claims.slice(0, 5);
}

/**
 * Score how specific/verifiable a claim is (0-10).
 * Higher scores = more concrete, data-driven claims.
 */
function claimSpecificityScore(claim: string): number {
  let score = 0;
  // Has percentage
  if (/\d+[.,]?\d*\s*%/.test(claim)) score += 3;
  // Has dollar amount
  if (/\$\d/.test(claim)) score += 3;
  // Has basis points
  if (/\d+\s*(bps|bp)\b/i.test(claim)) score += 3;
  // Has named entity (company, agency, etc.)
  if (/\b(Fed|Treasury|Bureau|FOMC|CPI|GDP|S&P|Nasdaq)\b/.test(claim)) score += 2;
  // Has a specific date or time reference
  if (/\b(January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4]|202[4-7])\b/i.test(claim)) score += 1;
  // Has "according to" or source attribution
  if (/according to|per |data from/i.test(claim)) score += 2;
  return score;
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
 *
 * Calibrated so that well-sourced financial claims (which typically contain
 * percentages, dollar figures, and attribution) score 70-80, passing the
 * fact-check threshold of 55 comfortably. Claims without data score 50-60.
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

  const hasRedFlag = redFlags.some((flag) => {
    // Use word boundary matching to avoid false positives like "overall" matching "all"
    const re = new RegExp(`\\b${flag}\\b`, "i");
    return re.test(lowerClaim);
  });

  // Green flags for credible claims — weighted by specificity
  let greenScore = 0;
  if (/\d+[.,]?\d*\s*%/.test(claim)) greenScore += 10;  // Specific percentage
  if (/\$\d/.test(claim)) greenScore += 10;               // Dollar amount
  if (/\d+\s*(bps|bp)\b/i.test(claim)) greenScore += 10; // Basis points
  if (/billion|million|trillion/i.test(claim)) greenScore += 8;
  if (/according to|per |reported|data from/i.test(claim)) greenScore += 8;
  if (/\breport\b|\bdata\b|\banalysis\b|\bresearch\b/i.test(claim)) greenScore += 5;

  // Specific financial terms boost confidence
  if (/\b(fed|federal reserve|fomc|treasury|cpi|gdp|bls|eia|fred)\b/i.test(claim)) {
    greenScore += 8;
  }
  if (/\b(earnings|revenue|eps|rate|yield|inflation)\b/i.test(claim)) {
    greenScore += 5;
  }

  // Base confidence calculation — starts at 55 (just above fact-check threshold)
  // so that even average financial claims pass, while garbage gets rejected
  let confidence = 55;
  if (hasRedFlag) confidence -= 15;
  confidence += Math.min(greenScore, 35); // Cap green boost at +35

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
}
