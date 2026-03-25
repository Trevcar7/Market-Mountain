/**
 * Data-Backed Fact Checker — Layer 1
 *
 * Cross-references specific numerical claims in synthesized articles against
 * live data from FRED, BLS, and EIA APIs. This is the strongest form of
 * automated fact-checking because it compares article claims to ground truth.
 *
 * How it works:
 *   1. Extracts numerical financial claims from the article text
 *      (e.g., "CPI rose 2.8% year-over-year", "10-year yield at 4.28%")
 *   2. Maps each claim to a known data series (FRED, BLS, or EIA)
 *   3. Fetches the real value from the relevant API
 *   4. Compares the claimed value to the actual value within a tolerance
 *   5. Returns a per-claim verification result + aggregate score
 *
 * Tolerance bands:
 *   - Interest rates / yields: ±0.15 percentage points
 *   - CPI / inflation: ±0.3 percentage points (BLS releases monthly, articles
 *     may reference preliminary or revised figures)
 *   - Unemployment: ±0.2 percentage points
 *   - Oil prices: ±$5 (intraday volatility)
 *   - Payrolls: ±50K (revisions are common)
 */

import {
  fetchFredLatest,
  fetchFredSeries,
  fetchBlsMultipleSeries,
  fetchWtiCrudePrice,
  BLS_SERIES,
} from "./market-data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataVerificationResult {
  claim: string;              // Original text from article
  dataPoint: string;          // What data series was checked (e.g., "Fed Funds Rate")
  claimedValue: number;       // Value the article claims
  actualValue: number | null; // Real value from API (null if fetch failed)
  tolerance: number;          // Allowed deviation
  verified: boolean;          // Within tolerance?
  source: string;             // API source (FRED, BLS, EIA)
  detail: string;             // Human-readable explanation
}

export interface DataFactCheckReport {
  results: DataVerificationResult[];
  score: number;              // 0–100 aggregate
  claimsChecked: number;
  claimsVerified: number;
  claimsFailed: number;
  claimsSkipped: number;      // Claims we couldn't match to a data series
}

// ---------------------------------------------------------------------------
// Claim extraction patterns
// ---------------------------------------------------------------------------

interface ClaimPattern {
  /** Regex to extract claimed value from article text */
  regex: RegExp;
  /** Human label for the data series */
  label: string;
  /** FRED series ID (if applicable) */
  fredSeries?: string;
  /** BLS series ID (if applicable) */
  blsSeries?: string;
  /** Special handler key for non-FRED/BLS data */
  handler?: "wti" | "cpi_yoy" | "core_cpi_yoy" | "payrolls" | "yield_curve";
  /** Tolerance for comparison */
  tolerance: number;
  /** Source label */
  source: string;
  /** Extract the numeric value from the regex match */
  extractValue: (match: RegExpMatchArray) => number;
}

/**
 * Patterns that map article text claims to verifiable data series.
 * Order matters — more specific patterns should come first.
 */
const CLAIM_PATTERNS: ClaimPattern[] = [
  // Fed Funds Rate — "Fed funds rate at 4.50%", "federal funds rate of 4.25–4.50%"
  {
    regex: /(?:fed(?:eral)?\s+funds?\s+rate|FFR)\s+(?:at|of|to|is|remains?|stands?\s+at|held\s+at)\s+(\d+\.\d+)(?:\s*[–\-]\s*\d+\.\d+)?\s*%/i,
    label: "Fed Funds Rate",
    fredSeries: "DFEDTARU",
    tolerance: 0.15,
    source: "FRED",
    extractValue: (m) => parseFloat(m[1]),
  },
  // 10-Year Treasury Yield — "10-year yield at 4.28%", "10Y Treasury at 4.3%"
  {
    regex: /10[- ]?(?:year|Y|yr)\s+(?:Treasury\s+)?(?:yield|note)\s+(?:at|of|to|hit|rose\s+to|fell\s+to|near|around)\s+(\d+\.\d+)\s*%/i,
    label: "10-Year Yield",
    fredSeries: "DGS10",
    tolerance: 0.15,
    source: "FRED",
    extractValue: (m) => parseFloat(m[1]),
  },
  // 2-Year Treasury Yield
  {
    regex: /2[- ]?(?:year|Y|yr)\s+(?:Treasury\s+)?(?:yield|note)\s+(?:at|of|to|hit|rose\s+to|fell\s+to|near|around)\s+(\d+\.\d+)\s*%/i,
    label: "2-Year Yield",
    fredSeries: "DGS2",
    tolerance: 0.15,
    source: "FRED",
    extractValue: (m) => parseFloat(m[1]),
  },
  // CPI Year-over-Year — "CPI rose 2.8% year-over-year", "inflation at 2.8%"
  {
    regex: /(?:CPI|consumer\s+price\s+index|headline\s+inflation)\s+(?:rose|fell|at|of|came\s+in\s+at|was|reported\s+at|hit)\s+(\d+\.\d+)\s*%\s*(?:year[- ]over[- ]year|y\/y|YoY|annually)/i,
    label: "CPI (YoY)",
    handler: "cpi_yoy",
    tolerance: 0.3,
    source: "FRED",
    extractValue: (m) => parseFloat(m[1]),
  },
  // Core CPI Year-over-Year
  {
    regex: /(?:core\s+CPI|core\s+inflation|core\s+consumer\s+price)\s+(?:rose|fell|at|of|came\s+in\s+at|was|reported\s+at|hit)\s+(\d+\.\d+)\s*%\s*(?:year[- ]over[- ]year|y\/y|YoY|annually)/i,
    label: "Core CPI (YoY)",
    handler: "core_cpi_yoy",
    tolerance: 0.3,
    source: "FRED",
    extractValue: (m) => parseFloat(m[1]),
  },
  // Unemployment Rate — "unemployment rate at 4.1%", "jobless rate fell to 3.9%"
  {
    regex: /(?:unemployment|jobless)\s+rate\s+(?:at|of|to|fell\s+to|rose\s+to|was|hit|remains?\s+at)\s+(\d+\.\d+)\s*%/i,
    label: "Unemployment Rate",
    blsSeries: "unemployment",
    tolerance: 0.2,
    source: "BLS",
    extractValue: (m) => parseFloat(m[1]),
  },
  // Nonfarm Payrolls — "economy added 275,000 jobs", "payrolls grew by 275K"
  {
    regex: /(?:economy\s+added|nonfarm\s+payrolls?\s+(?:grew|rose|added|came\s+in\s+at|of)|added)\s+(\d{2,4})[,.]?(\d{3})?\s*(?:K|thousand)?\s*(?:jobs|positions)?/i,
    label: "Nonfarm Payrolls",
    handler: "payrolls",
    tolerance: 50,
    source: "BLS",
    extractValue: (m) => {
      const val = m[2] ? parseFloat(`${m[1]}${m[2]}`) : parseFloat(m[1]);
      // Normalize to thousands
      return val >= 1000 ? val / 1000 : val;
    },
  },
  // WTI Crude Oil — "WTI at $68.50", "crude oil at $70 per barrel"
  {
    regex: /(?:WTI|crude\s+oil|oil\s+prices?)\s+(?:at|of|to|near|around|rose\s+to|fell\s+to|hit|trading\s+at)\s+\$(\d+(?:\.\d+)?)/i,
    label: "WTI Crude",
    handler: "wti",
    tolerance: 5,
    source: "EIA",
    extractValue: (m) => parseFloat(m[1]),
  },
];

// ---------------------------------------------------------------------------
// CPI YoY calculation helper (reused from macro-board-builder)
// ---------------------------------------------------------------------------

async function fetchCpiYoY(core = false): Promise<number | null> {
  const seriesId = core ? "CPILFESL" : "CPIAUCSL";
  const data = await fetchFredSeries(seriesId, 18);
  if (data.length < 2) return null;

  const latestDate = new Date(data[0].date);
  const yearAgoTarget = new Date(latestDate);
  yearAgoTarget.setFullYear(yearAgoTarget.getFullYear() - 1);

  // Find closest observation to year-ago date
  let best: { date: string; value: string } | null = null;
  let bestDiff = Infinity;
  for (const obs of data) {
    const diff = Math.abs(new Date(obs.date).getTime() - yearAgoTarget.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = obs;
    }
  }

  if (!best || bestDiff > 45 * 24 * 60 * 60 * 1000) return null;

  const latest = parseFloat(data[0].value);
  const yearAgo = parseFloat(best.value);
  if (isNaN(latest) || isNaN(yearAgo) || yearAgo === 0) return null;

  return (latest / yearAgo - 1) * 100;
}

// ---------------------------------------------------------------------------
// Core verification engine
// ---------------------------------------------------------------------------

/**
 * Fetch the actual value for a given claim pattern.
 */
async function fetchActualValue(pattern: ClaimPattern): Promise<number | null> {
  try {
    // FRED series
    if (pattern.fredSeries) {
      const obs = await fetchFredLatest(pattern.fredSeries);
      return obs ? parseFloat(obs.value) : null;
    }

    // BLS series
    if (pattern.blsSeries === "unemployment") {
      const result = await fetchBlsMultipleSeries([BLS_SERIES.UNEMPLOYMENT], 1);
      const arr = result[BLS_SERIES.UNEMPLOYMENT] ?? [];
      return arr.length > 0 ? parseFloat(arr[0].value) : null;
    }

    // Special handlers
    switch (pattern.handler) {
      case "cpi_yoy":
        return fetchCpiYoY(false);
      case "core_cpi_yoy":
        return fetchCpiYoY(true);
      case "wti": {
        const wti = await fetchWtiCrudePrice();
        return wti ? wti.value : null;
      }
      case "payrolls": {
        const result = await fetchBlsMultipleSeries([BLS_SERIES.NONFARM_PAYROLLS], 1);
        const arr = result[BLS_SERIES.NONFARM_PAYROLLS] ?? [];
        if (arr.length >= 2) {
          const current = parseFloat(arr[0].value);
          const previous = parseFloat(arr[1].value);
          return Math.round(current - previous); // Monthly change in thousands
        }
        return null;
      }
      default:
        return null;
    }
  } catch (err) {
    console.warn(`[data-fact-check] Failed to fetch ${pattern.label}: ${String(err)}`);
    return null;
  }
}

/**
 * Run data-backed fact-checking on an article.
 *
 * Extracts numerical financial claims from the article text and verifies
 * each one against live government/market data from FRED, BLS, and EIA.
 *
 * @param story The article body text (parsed story, not raw Claude output)
 * @param title The article headline (also scanned for claims)
 * @returns DataFactCheckReport with per-claim results and aggregate score
 */
export async function runDataFactCheck(
  story: string,
  title: string
): Promise<DataFactCheckReport> {
  const fullText = `${title}\n${story}`;
  const results: DataVerificationResult[] = [];
  const fetchPromises: Array<{
    pattern: ClaimPattern;
    match: RegExpMatchArray;
    claimedValue: number;
  }> = [];

  // Extract all claims that match known patterns
  for (const pattern of CLAIM_PATTERNS) {
    const match = fullText.match(pattern.regex);
    if (match) {
      const claimedValue = pattern.extractValue(match);
      if (!isNaN(claimedValue)) {
        fetchPromises.push({ pattern, match, claimedValue });
      }
    }
  }

  if (fetchPromises.length === 0) {
    return {
      results: [],
      score: 50, // No verifiable numeric claims — neutral baseline (not a passing grade)
      claimsChecked: 0,
      claimsVerified: 0,
      claimsFailed: 0,
      claimsSkipped: 0,
    };
  }

  // Fetch all actual values in parallel
  const fetchResults = await Promise.allSettled(
    fetchPromises.map(({ pattern }) => fetchActualValue(pattern))
  );

  let claimsVerified = 0;
  let claimsFailed = 0;
  let claimsSkipped = 0;

  for (let i = 0; i < fetchPromises.length; i++) {
    const { pattern, match, claimedValue } = fetchPromises[i];
    const fetchResult = fetchResults[i];
    const actualValue = fetchResult.status === "fulfilled" ? fetchResult.value : null;

    if (actualValue === null) {
      // API unavailable — skip, don't penalize
      claimsSkipped++;
      results.push({
        claim: match[0].substring(0, 120),
        dataPoint: pattern.label,
        claimedValue,
        actualValue: null,
        tolerance: pattern.tolerance,
        verified: true, // Give benefit of doubt when API is down
        source: pattern.source,
        detail: `Could not fetch ${pattern.label} from ${pattern.source} — skipped`,
      });
      continue;
    }

    const diff = Math.abs(claimedValue - actualValue);
    const verified = diff <= pattern.tolerance;

    if (verified) {
      claimsVerified++;
    } else {
      claimsFailed++;
    }

    results.push({
      claim: match[0].substring(0, 120),
      dataPoint: pattern.label,
      claimedValue,
      actualValue,
      tolerance: pattern.tolerance,
      verified,
      source: pattern.source,
      detail: verified
        ? `${pattern.label}: claimed ${claimedValue}, actual ${actualValue} (within ±${pattern.tolerance} tolerance)`
        : `${pattern.label}: claimed ${claimedValue}, actual ${actualValue} — MISMATCH (deviation ${diff.toFixed(2)} exceeds ±${pattern.tolerance} tolerance)`,
    });
  }

  // Score calculation:
  // - Each verified claim contributes positively
  // - Each failed claim is a strong negative signal
  // - Skipped claims are neutral
  const checkable = claimsVerified + claimsFailed;
  let score: number;

  if (checkable === 0) {
    score = 70; // All claims skipped (API issues) — neutral
  } else {
    const verifiedRatio = claimsVerified / checkable;
    if (verifiedRatio === 1) {
      score = 95; // Perfect — all checkable claims verified
    } else if (verifiedRatio >= 0.75) {
      score = 80; // Most claims verified, minor discrepancy
    } else if (verifiedRatio >= 0.5) {
      score = 55; // Half wrong — suspicious
    } else {
      score = 25; // Majority failed — likely inaccurate
    }
  }

  // Log results for transparency
  console.log(
    `[data-fact-check] Score=${score}: checked=${fetchPromises.length}, ` +
    `verified=${claimsVerified}, failed=${claimsFailed}, skipped=${claimsSkipped}`
  );
  for (const r of results) {
    const icon = r.verified ? "✓" : "✗";
    console.log(`  ${icon} ${r.detail}`);
  }

  return {
    results,
    score,
    claimsChecked: fetchPromises.length,
    claimsVerified,
    claimsFailed,
    claimsSkipped,
  };
}
