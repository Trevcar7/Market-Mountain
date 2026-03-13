/**
 * Editorial Quality Assurance Gate
 *
 * Runs a comprehensive 0–100 quality score on every synthesized article.
 * Only articles scoring ≥ 85 may be published.
 *
 * Scoring breakdown (100 points total):
 *   Confidence (20)     — composite editorial confidence score
 *   Fact check (10)     — claim verification score
 *   Source quality (15) — Tier 1 source presence + corroboration
 *   Title quality (15)  — word count, specificity, no vague language
 *   Thesis clarity (20) — four editorial questions answered
 *   Image quality (10)  — image present + unique vs. existing feed
 *   Story completeness (10) — length + numerical grounding
 *
 * Minimum score to publish: 85 / 100
 */

import { NewsItem } from "./news-types";

export interface QATestResult {
  test: string;
  passed: boolean;
  score: number;       // Points earned for this test
  maxScore: number;    // Max possible points for this test
  detail?: string;
}

export interface QAResult {
  score: number;          // 0–100
  passed: boolean;        // score >= QA_PASS_THRESHOLD
  tests: QATestResult[];
  rejectionReason?: string;
}

/** Minimum quality score required to publish. */
export const QA_PASS_THRESHOLD = 85;

// ---------------------------------------------------------------------------
// Tier classification for source quality check
// ---------------------------------------------------------------------------

const TIER_1_SOURCES = new Set([
  "reuters", "bloomberg", "wall street journal", "wsj",
  "financial times", "ft", "associated press", "ap",
  "cnbc", "the new york times", "nyt",
]);

const TIER_2_SOURCES = new Set([
  "fred", "bls", "eia", "us treasury", "treasury",
  "imf", "world bank", "morningstar", "seeking alpha",
  "fortune", "forbes",
]);

function classifySource(sourceName: string): "tier1" | "tier2" | "other" {
  const lower = sourceName.toLowerCase();
  if ([...TIER_1_SOURCES].some((t) => lower.includes(t))) return "tier1";
  if ([...TIER_2_SOURCES].some((t) => lower.includes(t))) return "tier2";
  return "other";
}

// ---------------------------------------------------------------------------
// Title quality helpers
// ---------------------------------------------------------------------------

/** Vague language patterns that weaken titles. */
const VAGUE_TITLE_PATTERNS = [
  /\bmarket[s]?\s+move[s]?\b/i,
  /\bstocks?\s+(rise|fall|move|shift)\b/i,
  /\bgeopoliti/i,
  /\buncertainty\b/i,
  /\bconcern[s]?\b/i,
  /\bvolatil/i,
  /\bexpect[s]?\b/i,
  /\bwatch\b/i,
  /\bglobal\s+issues?\b/i,
];

/** Specificity patterns: numbers, ticker symbols, named entities. */
const SPECIFICITY_PATTERNS = [
  /\d+[.,]\d+/,          // Decimal number (e.g., 4.50, 2.3%)
  /\d+%/,                // Percentage
  /\$\d+/,               // Dollar amount
  /\d+\s*(bps|bp)\b/i,  // Basis points
  /\b[A-Z]{2,5}\b/,      // Ticker-like symbol
  /\b\d{4}\b/,           // Year
];

function scoreTitle(title: string): QATestResult {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  let score = 0;
  const details: string[] = [];

  // Word count: 8–12 words = ideal
  if (wordCount >= 8 && wordCount <= 12) {
    score += 5;
  } else if (wordCount >= 6 && wordCount <= 15) {
    score += 3;
    details.push(`title has ${wordCount} words (ideal: 8–12)`);
  } else {
    details.push(`title word count ${wordCount} outside acceptable range (8–12)`);
  }

  // Specificity: must contain a number or proper noun
  const hasSpecificity = SPECIFICITY_PATTERNS.some((p) => p.test(title));
  if (hasSpecificity) {
    score += 5;
  } else {
    details.push("title lacks specific number or named entity");
  }

  // No vague language
  const vagueMatch = VAGUE_TITLE_PATTERNS.find((p) => p.test(title));
  if (!vagueMatch) {
    score += 5;
  } else {
    details.push(`title contains vague language: "${vagueMatch.source}"`);
  }

  return {
    test: "Title Quality",
    passed: score >= 10,
    score,
    maxScore: 15,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Thesis clarity — the four editorial questions
// ---------------------------------------------------------------------------

function scoreThesisClarity(article: NewsItem): QATestResult {
  let score = 0;
  const details: string[] = [];

  // Q1: What changed? — covered by story body
  // Q2: Why does it matter? — whyThisMatters field
  if (article.whyThisMatters && article.whyThisMatters.length >= 20) {
    score += 5;
  } else {
    details.push("missing or thin whyThisMatters field (Q2: why it matters)");
  }

  // Q3: Which assets are affected? — keyTakeaways or relatedTickers
  const hasTickers = (article.relatedTickers?.length ?? 0) > 0;
  const hasTakeaways = (article.keyTakeaways?.length ?? 0) >= 2;
  if (hasTickers || hasTakeaways) {
    score += 5;
  } else {
    details.push("no related tickers or key takeaways (Q3: which assets affected)");
  }

  // Q4: What to watch next? — whatToWatchNext field
  if (article.whatToWatchNext && article.whatToWatchNext.length >= 20) {
    score += 5;
  } else {
    details.push("missing or thin whatToWatchNext field (Q4: what to watch)");
  }

  // Story structure: ≥3 paragraphs (what changed is implicitly the story body)
  const paragraphs = article.story.split(/\n\n+/).filter((p) => p.trim().length > 40);
  if (paragraphs.length >= 3) {
    score += 5;
  } else {
    details.push(`story has only ${paragraphs.length} paragraphs (need ≥3)`);
  }

  return {
    test: "Thesis Clarity",
    passed: score >= 15,
    score,
    maxScore: 20,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Source quality
// ---------------------------------------------------------------------------

function scoreSourceQuality(article: NewsItem): QATestResult {
  const sourceTiers = article.sourcesUsed.map((s) => classifySource(s.source));
  const hasTier1 = sourceTiers.some((t) => t === "tier1");
  const hasTier2 = sourceTiers.some((t) => t === "tier2");
  const sourceCount = new Set(article.sourcesUsed.map((s) => s.source.toLowerCase())).size;

  let score = 0;
  const details: string[] = [];

  if (hasTier1 && sourceCount >= 2) {
    score = 15;
  } else if (hasTier1) {
    score = 10;
    details.push("only 1 Tier 1 source (prefer ≥2 sources)");
  } else if (hasTier2) {
    score = 5;
    details.push("no Tier 1 source present");
  } else {
    score = 0;
    details.push("no Tier 1 or Tier 2 source");
  }

  return {
    test: "Source Quality",
    passed: score >= 10,
    score,
    maxScore: 15,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Confidence score gate
// ---------------------------------------------------------------------------

function scoreConfidence(article: NewsItem): QATestResult {
  const confidence = article.confidenceScore ?? 0;
  let score = 0;
  let detail: string | undefined;

  if (confidence >= 0.85) {
    score = 20;
  } else if (confidence >= 0.75) {
    score = 17;
  } else if (confidence >= 0.70) {
    score = 15;
    detail = `confidence ${confidence} is just above minimum`;
  } else if (confidence >= 0.60) {
    score = 8;
    detail = `confidence ${confidence} below preferred threshold of 0.70`;
  } else {
    score = 0;
    detail = `confidence ${confidence} too low`;
  }

  return {
    test: "Editorial Confidence",
    passed: score >= 15,
    score,
    maxScore: 20,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Fact check score gate
// ---------------------------------------------------------------------------

function scoreFactCheck(article: NewsItem): QATestResult {
  const fc = article.factCheckScore ?? 0;
  let score = 0;
  let detail: string | undefined;

  if (fc >= 70) {
    score = 10;
  } else if (fc >= 55) {
    score = 7;
    detail = `fact check score ${fc} is adequate but not strong`;
  } else if (fc >= 40) {
    score = 3;
    detail = `fact check score ${fc} is weak`;
  } else {
    score = 0;
    detail = `fact check score ${fc} is too low`;
  }

  return {
    test: "Fact Verification",
    passed: score >= 7,
    score,
    maxScore: 10,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Image quality
// ---------------------------------------------------------------------------

function scoreImageQuality(article: NewsItem, existingArticles: NewsItem[]): QATestResult {
  let score = 0;
  const details: string[] = [];

  // Has an image URL
  if (article.imageUrl && article.imageUrl.startsWith("http")) {
    score += 5;
  } else {
    details.push("no image URL");
  }

  // Image is unique — not already used by an existing article
  if (article.imageUrl) {
    // Compare base URL (strip query params for comparison)
    const baseUrl = article.imageUrl.split("?")[0];
    const isDuplicate = existingArticles.some((existing) => {
      if (!existing.imageUrl) return false;
      return existing.imageUrl.split("?")[0] === baseUrl;
    });

    if (!isDuplicate) {
      score += 5;
    } else {
      details.push("image URL already used by another article in the feed");
    }
  }

  return {
    test: "Image Quality",
    passed: score >= 5,
    score,
    maxScore: 10,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Story completeness
// ---------------------------------------------------------------------------

const NUMERICAL_PATTERN = /(\d+[.,]?\d*\s*(%|bps|bp|billion|million|trillion|\$)|\$\d+[.,]?\d*[BM]?)/gi;

function scoreStoryCompleteness(article: NewsItem): QATestResult {
  let score = 0;
  const details: string[] = [];

  // Story length ≥ 400 characters
  if (article.story.length >= 400) {
    score += 5;
  } else {
    details.push(`story body only ${article.story.length} chars (need ≥400)`);
  }

  // At least 2 numerical data points in story body
  const numericalMatches = article.story.match(NUMERICAL_PATTERN);
  if ((numericalMatches?.length ?? 0) >= 2) {
    score += 5;
  } else {
    details.push(`story has only ${numericalMatches?.length ?? 0} data points (need ≥2)`);
  }

  return {
    test: "Story Completeness",
    passed: score >= 8,
    score,
    maxScore: 10,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// MAIN: Run all QA tests
// ---------------------------------------------------------------------------

/**
 * Run the full editorial quality gate on a synthesized article.
 *
 * @param article        - The NewsItem to evaluate
 * @param existingArticles - Active articles already in the feed (for image dedup)
 * @returns QAResult with score, pass/fail, and per-test breakdown
 */
export function runEditorialQA(
  article: NewsItem,
  existingArticles: NewsItem[]
): QAResult {
  const tests: QATestResult[] = [
    scoreConfidence(article),
    scoreFactCheck(article),
    scoreSourceQuality(article),
    scoreTitle(article.title),
    scoreThesisClarity(article),
    scoreImageQuality(article, existingArticles),
    scoreStoryCompleteness(article),
  ];

  const score = tests.reduce((sum, t) => sum + t.score, 0);
  const passed = score >= QA_PASS_THRESHOLD;

  // Build a concise rejection reason from the failing tests
  let rejectionReason: string | undefined;
  if (!passed) {
    const failedTests = tests
      .filter((t) => !t.passed)
      .map((t) => `${t.test} (${t.score}/${t.maxScore}${t.detail ? `: ${t.detail}` : ""})`)
      .join("; ");
    rejectionReason = `QA score ${score}/100 < ${QA_PASS_THRESHOLD} minimum. Failed: ${failedTests}`;
  }

  return { score, passed, tests, rejectionReason };
}

/**
 * Log a structured QA result for diagnostics.
 */
export function logQAResult(topic: string, result: QAResult): void {
  const status = result.passed ? "✓ PASS" : "✗ FAIL";
  console.log(`[editorial-qa] ${status} "${topic}" — score=${result.score}/100`);
  for (const t of result.tests) {
    const icon = t.passed ? "  ✓" : "  ✗";
    const detail = t.detail ? ` — ${t.detail}` : "";
    console.log(`${icon} ${t.test}: ${t.score}/${t.maxScore}${detail}`);
  }
  if (!result.passed && result.rejectionReason) {
    console.warn(`[editorial-qa] Rejection: ${result.rejectionReason}`);
  }
}
