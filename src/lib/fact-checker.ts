import { FactCheckResult, NewsSource } from "./news-types";
import { runDataFactCheck, DataFactCheckReport } from "./data-fact-checker";
import { runSourceAlignment, SourceAlignmentReport, checkEntityRelationships, EntityRelationshipReport } from "./source-alignment";

// ---------------------------------------------------------------------------
// Comprehensive Fact Check Report — combines all verification layers
// ---------------------------------------------------------------------------

export interface ComprehensiveFactCheckReport {
  /** Layer 1: Keyword/API heuristic (original fact-checker) */
  heuristicScore: number;
  heuristicResults: FactCheckResult[];

  /** Layer 2: Data-backed verification (FRED/BLS/EIA cross-reference) */
  dataVerification: DataFactCheckReport | null;

  /** Layer 3: Source-alignment check (synthesis vs. sources) */
  sourceAlignment: SourceAlignmentReport | null;

  /** Layer 4: Entity relationship verification (fabrication detection) */
  entityRelationships: EntityRelationshipReport | null;

  /** Combined weighted score (0–100) */
  compositeScore: number;

  /** Per-layer breakdown for logging */
  breakdown: string;
}

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

// ---------------------------------------------------------------------------
// Comprehensive Multi-Layer Fact Check
// ---------------------------------------------------------------------------
//
// Combines three verification layers into a single composite score:
//
//   Layer 1 — Heuristic (30% weight)
//     Original keyword/Google Fact Check API scoring.
//     Fast, always available, but shallow.
//
//   Layer 2 — Data Verification (40% weight)
//     Cross-references numerical claims (CPI, yields, oil prices, etc.)
//     against live FRED/BLS/EIA data. Strongest signal for financial articles.
//     Returns null if no verifiable numerical claims are found.
//
//   Layer 3 — Source Alignment (30% weight)
//     Uses Claude to verify synthesized claims trace back to source articles.
//     Catches hallucinations — facts the AI invented beyond source material.
//     Returns null if source texts are unavailable.
//
// The composite score is a weighted average with fallback handling:
//   - If all 3 layers run: 30% heuristic + 40% data + 30% source
//   - If data layer is null (no numeric claims): 50% heuristic + 50% source
//   - If source layer is null (no source texts): 40% heuristic + 60% data
//   - If both are null: 100% heuristic (original behavior)
// ---------------------------------------------------------------------------

/**
 * Run the full multi-layer fact-check pipeline.
 *
 * @param story       Parsed story body text
 * @param title       Article headline
 * @param sources     sourcesUsed from the NewsItem
 * @param sourceTexts Original article snippets (from formatNewsForStorage)
 * @returns ComprehensiveFactCheckReport with composite score
 */
export async function runComprehensiveFactCheck(
  story: string,
  title: string,
  sources: NewsSource[],
  sourceTexts: string[]
): Promise<ComprehensiveFactCheckReport> {
  // Layer 1 — Heuristic (always runs)
  const claims = extractClaimsFromStory(story);
  const { results: heuristicResults, overallScore: heuristicScore } =
    await verifyClaims(claims);

  // Layer 2 — Data Verification (runs in parallel with Layer 3 & 4)
  // Layer 3 — Source Alignment (runs in parallel with Layer 2 & 4)
  // Layer 4 — Entity Relationship Verification (runs in parallel with Layer 2 & 3)
  const hasSources = sources.length > 0 && sourceTexts.length > 0;
  const [dataResult, sourceResult, entityResult] = await Promise.allSettled([
    runDataFactCheck(story, title),
    hasSources
      ? runSourceAlignment(story, title, sources, sourceTexts)
      : Promise.resolve(null),
    hasSources
      ? checkEntityRelationships(story, title, sources, sourceTexts)
      : Promise.resolve(null),
  ]);

  const dataVerification: DataFactCheckReport | null =
    dataResult.status === "fulfilled" ? dataResult.value : null;
  const sourceAlignment: SourceAlignmentReport | null =
    sourceResult.status === "fulfilled" ? sourceResult.value : null;
  const entityRelationships: EntityRelationshipReport | null =
    entityResult.status === "fulfilled" ? entityResult.value : null;

  // Compute composite score with dynamic weighting
  let compositeScore: number;
  const breakdown: string[] = [];

  const hasData = dataVerification !== null && dataVerification.claimsChecked > 0;
  const hasSource = sourceAlignment !== null && sourceAlignment.claims.length > 0;

  if (hasData && hasSource) {
    // All 3 layers — full weighting
    compositeScore = Math.round(
      heuristicScore * 0.30 +
      dataVerification!.score * 0.40 +
      sourceAlignment!.score * 0.30
    );
    breakdown.push(
      `heuristic=${heuristicScore}×0.30`,
      `data=${dataVerification!.score}×0.40`,
      `source=${sourceAlignment!.score}×0.30`
    );
  } else if (hasData && !hasSource) {
    // Data + heuristic only
    compositeScore = Math.round(
      heuristicScore * 0.40 +
      dataVerification!.score * 0.60
    );
    breakdown.push(
      `heuristic=${heuristicScore}×0.40`,
      `data=${dataVerification!.score}×0.60`,
      `source=N/A`
    );
  } else if (!hasData && hasSource) {
    // Source + heuristic only
    compositeScore = Math.round(
      heuristicScore * 0.50 +
      sourceAlignment!.score * 0.50
    );
    breakdown.push(
      `heuristic=${heuristicScore}×0.50`,
      `data=N/A`,
      `source=${sourceAlignment!.score}×0.50`
    );
  } else {
    // Heuristic only (original behavior)
    compositeScore = heuristicScore;
    breakdown.push(
      `heuristic=${heuristicScore}×1.00`,
      `data=N/A`,
      `source=N/A`
    );
  }

  // Hard penalty: if data verification found ANY mismatches, cap composite at 60
  if (dataVerification && dataVerification.claimsFailed > 0) {
    compositeScore = Math.min(compositeScore, 60);
    breakdown.push(`DATA_MISMATCH_CAP=60`);
  }

  // Hard penalty: if source alignment found ≥3 hallucinations, cap composite at 50
  if (sourceAlignment && sourceAlignment.ungroundedCount >= 3) {
    compositeScore = Math.min(compositeScore, 50);
    breakdown.push(`HALLUCINATION_CAP=50`);
  }

  // Hard penalty: if ANY entity relationship is fabricated, cap at 30
  // This is the most aggressive cap because fabricated entity relationships
  // (e.g., "Apple acquires IBM") are the highest-risk hallucination type.
  if (entityRelationships && entityRelationships.fabricatedCount > 0) {
    compositeScore = Math.min(compositeScore, 30);
    breakdown.push(`FABRICATED_RELATIONSHIP_CAP=30 (${entityRelationships.fabricatedCount} fabricated)`);
  }

  const breakdownStr = breakdown.join(", ");
  console.log(`[fact-check] Composite=${compositeScore}: ${breakdownStr}`);

  return {
    heuristicScore,
    heuristicResults,
    dataVerification,
    sourceAlignment,
    entityRelationships,
    compositeScore,
    breakdown: breakdownStr,
  };
}
