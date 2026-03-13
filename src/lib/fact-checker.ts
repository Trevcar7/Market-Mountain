import { FactCheckResult } from "./news-types";

/**
 * Extract verifiable claims/facts from synthesized story text
 * Looks for statements that can be fact-checked
 */
export function extractClaimsFromStory(story: string): string[] {
  const claims: string[] = [];

  // Split into sentences
  const sentences = story.match(/[^.!?]+[.!?]+/g) || [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();

    // Look for fact-based statements (not opinions)
    // Filter: exclude pure opinions, subjective assessments
    if (
      trimmed.length > 20 &&
      !trimmed.includes("I think") &&
      !trimmed.includes("should") &&
      !trimmed.includes("may") &&
      !trimmed.includes("could") &&
      !trimmed.includes("appears to be")
    ) {
      // Extract specific factual claim (first 15-20 words)
      const words = trimmed.split(" ");
      const claim = words.slice(0, Math.min(15, words.length)).join(" ");
      claims.push(claim);
    }
  }

  // Return top 3-5 most important claims
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
    return { results: [], overallScore: 50 }; // Default to medium confidence if no claims
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

      const data = (await response.json()) as any;
      const claims_data = data.claims || [];

      if (claims_data.length > 0) {
        // Check if Google found verification
        const topClaim = claims_data[0];
        const rating = topClaim.claimReview?.[0]?.textualRating || "UNKNOWN";

        const verified =
          rating === "TRUE" || rating === "MOSTLY_TRUE" || rating === "SUPPORTED";

        results.push({
          claim,
          verified,
          confidence: verified ? 90 : 30,
          sources: topClaim.claimReview?.map((r: any) => r.url) || [],
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
 * Fallback fact-checking when API is unavailable
 * Uses heuristics to estimate claim validity
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
    explanation: `Heuristic check (no API result)`,
  };
}

/**
 * Score fact-check results
 * Returns 0-100 confidence that story is accurate
 */
export function scoreFactCheckResult(results: FactCheckResult[]): number {
  if (results.length === 0) return 70; // Default: assume accurate if no claims

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
