/**
 * Editorial Quality Assurance Gate — v2
 *
 * Runs a comprehensive 0–100 quality score on every synthesized article.
 * Only articles scoring ≥ 85 may be published.
 *
 * Scoring breakdown (100 points total):
 *   Story Worthiness  (15) — market impact, catalyst chain, investor implication
 *   Confidence        (15) — composite editorial confidence score
 *   Fact Check        (10) — claim verification score
 *   Source Quality    (10) — Tier 1 source presence + corroboration
 *   Title Quality     (10) — word count, specificity, no vague language
 *   Thesis Clarity    (10) — four editorial questions answered
 *   Chart Quality     (10) — mandatory for key topics; internal quality score
 *   Story Completeness (5) — length (≥120 words) + numerical grounding
 *   Originality        (5) — language similarity vs. recent articles
 *   Editorial Voice    (5) — no generic filler phrases
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
// Topic classification constants
// ---------------------------------------------------------------------------

/** Topics that map to known market-impacting categories. */
const MARKET_IMPACT_TOPICS = new Set([
  "federal_reserve", "fed_macro", "inflation", "gdp", "employment",
  "bond_market", "trade_policy", "trade_policy_tariff", "broad_market",
  "markets", "crypto", "energy", "earnings", "merger_acquisition",
  "bankruptcy", "ipo", "layoffs", "commodities", "currency",
]);

/**
 * Topics that REQUIRE a chart to be included.
 * Articles on these topics without chart data score 0 on Chart Quality.
 */
const CHART_REQUIRED_TOPICS = new Set([
  "inflation", "energy", "employment", "federal_reserve", "fed_macro",
  "gdp", "bond_market", "broad_market", "markets", "crypto",
  "trade_policy", "earnings", "commodities", "currency",
]);

/**
 * Topic clusters for semantic duplicate detection.
 * If two articles share the same cluster and are within 24h of each other,
 * a tighter similarity threshold applies.
 */
const TOPIC_CLUSTERS: string[][] = [
  ["energy", "trade_policy", "trade_policy_tariff", "commodities"],
  ["federal_reserve", "fed_macro", "inflation", "bond_market"],
  ["broad_market", "markets", "gdp"],
  ["employment", "layoffs"],
  ["crypto", "currency"],
];

function getTopicCluster(topicKey: string): number {
  for (let i = 0; i < TOPIC_CLUSTERS.length; i++) {
    if (TOPIC_CLUSTERS[i].includes(topicKey)) return i;
  }
  return -1; // No cluster
}

// ---------------------------------------------------------------------------
// Story Worthiness — market impact + catalyst chain + investor implication
// ---------------------------------------------------------------------------

/** Market reaction signals in synthesized content. */
const MARKET_REACTION_PATTERNS = [
  /\b(rise[sd]?|rise[sd]?|fell|fall[s]?|gain[s]?|drop[s]?|surge[sd]?|rally|rallied|sell.?off|selloff)\b/i,
  /\b(yield[s]?|rate[s]?|price[s]?|index|equit|stock[s]?|bond[s]?|treasury)\b/i,
  /\b\d+[.,]\d*\s*%/,                  // Decimal percentages (e.g., 2.3%)
  /\b\d+\s*(bps|bp)\b/i,               // Basis points
  /\b(inflation|oil|crude|fed|fomc)\b/i,
];

function scoreStoryWorthiness(article: NewsItem): QATestResult {
  let score = 0;
  const details: string[] = [];

  // 5 pts: topic maps to a known market-impacting category
  const topicInSet = article.topicKey ? MARKET_IMPACT_TOPICS.has(article.topicKey) : false;
  // Also allow earnings articles with a clear company-level signal
  const isEarningsWithSignal =
    article.topicKey === "earnings" &&
    /\b(beat|miss|exceed|surpass|disappoint|guidance|eps|revenue|profit)\b/i.test(
      article.title + " " + (article.story?.slice(0, 300) ?? "")
    );

  if (topicInSet || isEarningsWithSignal) {
    score += 5;
  } else {
    details.push("topic does not map to a known market-impacting category");
  }

  // 5 pts: story + whyThisMatters contains ≥2 concrete market reaction signals
  const storyText = article.story + " " + (article.whyThisMatters ?? "");
  const reactionCount = MARKET_REACTION_PATTERNS.filter((p) => p.test(storyText)).length;
  if (reactionCount >= 2) {
    score += 5;
  } else {
    details.push(`only ${reactionCount} market reaction signal(s) — need ≥2 (price, yield, move, rate, etc.)`);
  }

  // 5 pts: investor implication present
  const hasTickers    = (article.relatedTickers?.length ?? 0) > 0;
  const hasKeyData    = (article.keyDataPoints?.length ?? 0) > 0;
  const hasWatchNext  = (article.whatToWatchNext?.length ?? 0) >= 30;
  const has2ndOrder   = (article.secondOrderImplication?.length ?? 0) >= 20;

  if (hasTickers || hasKeyData || hasWatchNext || has2ndOrder) {
    score += 5;
  } else {
    details.push("no investor implication (no tickers, key data, watch signal, or second-order)");
  }

  return {
    test: "Story Worthiness",
    passed: score >= 10,
    score,
    maxScore: 15,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Chart Quality — presence + internal 0–10 scoring
// ---------------------------------------------------------------------------

function scoreChartQuality(article: NewsItem): QATestResult {
  const requiresChart = article.topicKey ? CHART_REQUIRED_TOPICS.has(article.topicKey) : false;
  const chart = article.chartData;
  const hasChart = !!chart && (chart.values?.length ?? 0) > 0;

  // Chart required but missing → hard 0
  if (requiresChart && !hasChart) {
    return {
      test: "Chart Quality",
      passed: false,
      score: 0,
      maxScore: 10,
      detail: `topic "${article.topicKey}" requires a chart but none was generated — check API keys (FRED/BLS/EIA)`,
    };
  }

  // Chart not required and not present → full marks (no penalty)
  if (!hasChart) {
    return {
      test: "Chart Quality",
      passed: true,
      score: 10,
      maxScore: 10,
    };
  }

  // Chart is present — score it internally (0–10)
  let internal = 0;

  // Data richness (Adjustment 2: raised thresholds)
  if ((chart.values?.length ?? 0) >= 12) internal += 2;
  else if ((chart.values?.length ?? 0) >= 6) internal += 1;

  // Source attribution
  if (chart.source && chart.source.trim().length > 0) internal += 2;

  // Time range label
  if (chart.timeRange && chart.timeRange.trim().length > 0) internal += 1;

  // Reference value present for inflation / Fed topics (editorial context)
  const isInflationOrFed = ["inflation", "federal_reserve", "fed_macro"].includes(
    article.topicKey ?? ""
  );
  if (isInflationOrFed && chart.referenceValue !== undefined) internal += 1;
  else if (!isInflationOrFed) internal += 1; // Non-inflation topics don't need reference line

  // Values have meaningful spread (not all zeroes / flat)
  const vals = chart.values ?? [];
  if (vals.length >= 2) {
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const spread = Math.max(...vals) - Math.min(...vals);
    const hasSpread = avg !== 0 ? spread / Math.abs(avg) > 0.005 : spread > 0;
    if (hasSpread) internal += 2;
  }

  // Chart type appropriate for data
  const isLineOk = chart.type === "line" && !!chart.unit?.match(/%|bbl|\$/);
  const isBarOk  = chart.type === "bar"  && !!chart.unit?.match(/%|K/);
  if (isLineOk || isBarOk || chart.type === "line") internal += 1; // Line is default-acceptable

  const qaScore = Math.min(10, internal);

  return {
    test: "Chart Quality",
    passed: qaScore >= 5,
    score: qaScore,
    maxScore: 10,
    detail: qaScore < 5 ? `internal chart score ${qaScore}/10 — check data richness and source attribution` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Originality — language similarity vs. recent articles
// ---------------------------------------------------------------------------

/**
 * Compute approximate language similarity between two strings.
 * Uses word-level overlap on meaningful words (>4 chars, non-numeric).
 * Returns 0–1 where 1 = identical vocabulary.
 */
function computeWordSimilarity(a: string, b: string): number {
  const meaningful = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 4 && !/^\d+$/.test(w))
    );
  const wordsA = meaningful(a);
  const wordsB = meaningful(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

function scoreOriginality(article: NewsItem, existingArticles: NewsItem[]): QATestResult {
  if (existingArticles.length === 0) {
    return { test: "Originality", passed: true, score: 5, maxScore: 5 };
  }

  const articleTime = new Date(article.publishedAt).getTime();
  // Only compare against articles from the past 48h
  const recentArticles = existingArticles.filter((a) => {
    const age = articleTime - new Date(a.publishedAt).getTime();
    return age >= 0 && age < 48 * 60 * 60 * 1000;
  });

  if (recentArticles.length === 0) {
    return { test: "Originality", passed: true, score: 5, maxScore: 5 };
  }

  const articleText =
    article.story + " " + (article.whyThisMatters ?? "") + " " + article.title;

  const articleCluster = getTopicCluster(article.topicKey ?? "");

  let maxSimilarity = 0;
  let mostSimilarTitle = "";
  let sameCluster = false;

  for (const existing of recentArticles) {
    const existingText =
      existing.story + " " + (existing.whyThisMatters ?? "") + " " + existing.title;
    const sim = computeWordSimilarity(articleText, existingText);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      mostSimilarTitle = existing.title;
    }
    // Check if they're in the same topic cluster
    if (articleCluster !== -1 && getTopicCluster(existing.topicKey ?? "") === articleCluster) {
      sameCluster = true;
    }
  }

  // Tighter threshold for articles in the same topic cluster published within 24h
  const sameCluster24h = sameCluster && recentArticles.some((a) => {
    const age = articleTime - new Date(a.publishedAt).getTime();
    return age < 24 * 60 * 60 * 1000 &&
      getTopicCluster(a.topicKey ?? "") === articleCluster;
  });

  // Thresholds (Adjustment 3: stricter than original)
  const hardRejectThreshold  = sameCluster24h ? 0.50 : 0.55;
  const softWarnThreshold    = sameCluster24h ? 0.35 : 0.40;

  let score: number;
  let detail: string | undefined;

  if (maxSimilarity >= hardRejectThreshold) {
    score = 0;
    detail = `${Math.round(maxSimilarity * 100)}% similarity exceeds threshold${sameCluster24h ? " (same topic cluster, <24h)" : ""} — too similar to "${mostSimilarTitle.slice(0, 55)}..."`;
  } else if (maxSimilarity >= softWarnThreshold) {
    score = 3;
    detail = `${Math.round(maxSimilarity * 100)}% vocabulary overlap with "${mostSimilarTitle.slice(0, 55)}..."`;
  } else {
    score = 5;
  }

  return {
    test: "Originality",
    passed: score >= 3,
    score,
    maxScore: 5,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Editorial Voice — no generic filler phrases
// ---------------------------------------------------------------------------

const EDITORIAL_FILLER_PATTERNS: RegExp[] = [
  /\bremain[s]? to be seen\b/i,
  /\bit is worth noting\b/i,
  /\bit should be noted\b/i,
  /\bsome analysts?\b/i,
  /\bobservers?\s+(note|say|believe|suggest)\b/i,
  /\bmarket (sentiment|uncertainty) remain[s]?\b/i,
  /\bin (recent|the coming) (weeks|months|days)\b/i,
  /\bgoing forward\b/i,
  /\bin a sign of\b/i,
  /\bthe broader picture\b/i,
];

function scoreEditorialVoice(article: NewsItem): QATestResult {
  const fillerMatches = EDITORIAL_FILLER_PATTERNS.filter((p) =>
    p.test(article.story)
  );
  const count = fillerMatches.length;

  let score: number;
  let detail: string | undefined;

  if (count === 0) {
    score = 5;
  } else if (count === 1) {
    score = 3;
    detail = `1 generic filler phrase detected in story body`;
  } else {
    score = 0;
    detail = `${count} generic filler phrases detected — editorial voice lacks precision`;
  }

  return {
    test: "Editorial Voice",
    passed: score >= 3,
    score,
    maxScore: 5,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Title quality
// ---------------------------------------------------------------------------

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

const SPECIFICITY_PATTERNS = [
  /\d+[.,]\d+/,
  /\d+%/,
  /\$\d+/,
  /\d+\s*(bps|bp)\b/i,
  /\b[A-Z]{2,5}\b/,
  /\b\d{4}\b/,
];

function scoreTitle(title: string): QATestResult {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  let score = 0;
  const details: string[] = [];

  // 4 pts for ideal 8–12 word range; 2 pts for acceptable 6–15
  if (wordCount >= 8 && wordCount <= 12) {
    score += 4;
  } else if (wordCount >= 6 && wordCount <= 15) {
    score += 2;
    details.push(`title has ${wordCount} words (ideal: 8–12)`);
  } else {
    details.push(`title word count ${wordCount} outside acceptable range (8–12)`);
  }

  // 3 pts: specificity — number, ticker, or named entity
  const hasSpecificity = SPECIFICITY_PATTERNS.some((p) => p.test(title));
  if (hasSpecificity) {
    score += 3;
  } else {
    details.push("title lacks specific number or named entity");
  }

  // 3 pts: no vague language
  const vagueMatch = VAGUE_TITLE_PATTERNS.find((p) => p.test(title));
  if (!vagueMatch) {
    score += 3;
  } else {
    details.push(`title contains vague language matching "${vagueMatch.source}"`);
  }

  return {
    test: "Title Quality",
    passed: score >= 7,
    score,
    maxScore: 10,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Thesis clarity — the four editorial questions
// ---------------------------------------------------------------------------

function scoreThesisClarity(article: NewsItem): QATestResult {
  let score = 0;
  const details: string[] = [];

  // Q2: Why does it matter?
  if (article.whyThisMatters && article.whyThisMatters.length >= 20) {
    score += 3;
  } else {
    details.push("missing or thin whyThisMatters (Q2: why it matters)");
  }

  // Q3: Which assets are affected?
  const hasTickers   = (article.relatedTickers?.length ?? 0) > 0;
  const hasTakeaways = (article.keyTakeaways?.length ?? 0) >= 2;
  if (hasTickers || hasTakeaways) {
    score += 2;
  } else {
    details.push("no related tickers or key takeaways (Q3: which assets)");
  }

  // Q4: What to watch next?
  if (article.whatToWatchNext && article.whatToWatchNext.length >= 20) {
    score += 3;
  } else {
    details.push("missing or thin whatToWatchNext (Q4: what to watch)");
  }

  // Story structure: ≥3 substantive paragraphs
  const paragraphs = article.story
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 40);
  if (paragraphs.length >= 3) {
    score += 2;
  } else {
    details.push(`story has only ${paragraphs.length} paragraphs (need ≥3)`);
  }

  return {
    test: "Thesis Clarity",
    passed: score >= 7,
    score,
    maxScore: 10,
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
  const sourceCount = new Set(
    article.sourcesUsed.map((s) => s.source.toLowerCase())
  ).size;

  let score = 0;
  const details: string[] = [];

  if (hasTier1 && sourceCount >= 2) {
    score = 10;
  } else if (hasTier1) {
    score = 7;
    details.push("only 1 Tier 1 source (prefer ≥2 sources)");
  } else if (hasTier2) {
    score = 4;
    details.push("no Tier 1 source present");
  } else {
    score = 0;
    details.push("no Tier 1 or Tier 2 source");
  }

  return {
    test: "Source Quality",
    passed: score >= 7,
    score,
    maxScore: 10,
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
    score = 15;
  } else if (confidence >= 0.75) {
    score = 13;
  } else if (confidence >= 0.70) {
    score = 11;
    detail = `confidence ${confidence} is just above minimum`;
  } else if (confidence >= 0.60) {
    score = 6;
    detail = `confidence ${confidence} below preferred threshold of 0.70`;
  } else {
    score = 0;
    detail = `confidence ${confidence} too low`;
  }

  return {
    test: "Editorial Confidence",
    passed: score >= 11,
    score,
    maxScore: 15,
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

  if (article.imageUrl && article.imageUrl.startsWith("http")) {
    score += 3;
  } else {
    details.push("no image URL");
  }

  if (article.imageUrl) {
    const baseUrl = article.imageUrl.split("?")[0];
    const isDuplicate = existingArticles.some(
      (ex) => ex.imageUrl && ex.imageUrl.split("?")[0] === baseUrl
    );
    if (!isDuplicate) {
      score += 2;
    } else {
      details.push("image URL already used by another article");
    }
  }

  return {
    test: "Image Quality",
    passed: score >= 3,
    score,
    maxScore: 5,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Story completeness — length + numerical grounding
// ---------------------------------------------------------------------------

const NUMERICAL_PATTERN =
  /(\d+[.,]?\d*\s*(%|bps|bp|billion|million|trillion|\$)|\$\d+[.,]?\d*[BM]?)/gi;

function scoreStoryCompleteness(article: NewsItem): QATestResult {
  let score = 0;
  const details: string[] = [];

  // Story length ≥ 700 chars (≈120–180 words minimum per spec)
  if (article.story.length >= 700) {
    score += 3;
  } else {
    details.push(`story body only ${article.story.length} chars (need ≥700, ≈120 words)`);
  }

  // At least 2 numerical data points in story body
  const numericalMatches = article.story.match(NUMERICAL_PATTERN);
  if ((numericalMatches?.length ?? 0) >= 2) {
    score += 2;
  } else {
    details.push(`story has only ${numericalMatches?.length ?? 0} data points (need ≥2)`);
  }

  return {
    test: "Story Completeness",
    passed: score >= 3,
    score,
    maxScore: 5,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// MAIN: Run all QA tests
// ---------------------------------------------------------------------------

/**
 * Run the full editorial quality gate on a synthesized article.
 *
 * @param article          - The NewsItem to evaluate
 * @param existingArticles - Active articles already in the feed (for image + originality dedup)
 * @returns QAResult with score, pass/fail, and per-test breakdown
 */
export function runEditorialQA(
  article: NewsItem,
  existingArticles: NewsItem[]
): QAResult {
  const tests: QATestResult[] = [
    scoreStoryWorthiness(article),
    scoreConfidence(article),
    scoreFactCheck(article),
    scoreSourceQuality(article),
    scoreTitle(article.title),
    scoreThesisClarity(article),
    scoreChartQuality(article),
    scoreStoryCompleteness(article),
    scoreOriginality(article, existingArticles),
    scoreEditorialVoice(article),
    scoreImageQuality(article, existingArticles),
  ];

  const score = tests.reduce((sum, t) => sum + t.score, 0);
  const passed = score >= QA_PASS_THRESHOLD;

  let rejectionReason: string | undefined;
  if (!passed) {
    const failedTests = tests
      .filter((t) => !t.passed)
      .map(
        (t) =>
          `${t.test} (${t.score}/${t.maxScore}${t.detail ? `: ${t.detail}` : ""})`
      )
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
