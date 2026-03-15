/**
 * Editorial Quality Assurance Gate — v2
 *
 * Runs a comprehensive 0–100 quality score on every synthesized article.
 * Only articles scoring ≥ QA_PASS_THRESHOLD may be published.
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
 * Production threshold: 85 / 100
 * Rebuild mode threshold: 78 / 100 (set REBUILD_MODE=true in env)
 */

/**
 * Rebuild mode — set REBUILD_MODE=true in Vercel env vars to temporarily
 * lower thresholds so the first 2 strong articles can populate an empty feed.
 * Chart hard-fail becomes a soft 6/10 partial credit.
 * Remove after feed has ≥3 published articles.
 */
const REBUILD_MODE = process.env.REBUILD_MODE === "true";

import { NewsItem } from "./news-types";
import { TIER_1_SOURCES, TIER_2_SOURCES } from "./news";

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

/**
 * Minimum quality score required to publish.
 * Production: 85 | Rebuild mode: 72
 *
 * Why 72 in rebuild:
 *   - Chart soft-fail costs up to 4 pts when FRED/BLS/EIA keys are missing
 *   - Confidence band 0.58–0.70 costs up to 5 pts vs production scoring
 *   - Together these two penalties can drop a strong story from ~83 to ~74
 *   - Threshold 72 gives enough headroom while still blocking thin content
 */
export const QA_PASS_THRESHOLD = REBUILD_MODE ? 72 : 85;

if (REBUILD_MODE) {
  console.log(
    "[editorial-qa] REBUILD MODE ACTIVE — threshold=72/100, chart soft-fail=8/10, " +
    "editorial-voice softened. Set REBUILD_MODE=true in env. Remove once feed has ≥3 articles."
  );
}

// ---------------------------------------------------------------------------
// Tier classification for source quality check
// ---------------------------------------------------------------------------

// Uses TIER_1_SOURCES / TIER_2_SOURCES imported from news.ts (single source
// of truth) so confidence gate and QA gate always agree on source tiers.

function classifySource(sourceName: string): "tier1" | "tier2" | "other" {
  const lower = sourceName.toLowerCase();
  if (TIER_1_SOURCES.some((t) => lower.includes(t))) return "tier1";
  if (TIER_2_SOURCES.some((t) => lower.includes(t))) return "tier2";
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
  // chartData is now ChartDataset[] — use first chart for quality scoring
  const chartArr = article.chartData;
  const chart = Array.isArray(chartArr) ? chartArr[0] : (chartArr as import("./news-types").ChartDataset | undefined);
  const hasChart = !!chart && (chart.values?.length ?? 0) > 0;

  // Chart required but missing
  if (requiresChart && !hasChart) {
    if (REBUILD_MODE) {
      // Soft-fail in rebuild mode: 8/10 partial credit instead of hard 0.
      // Raised from 6/10 — combined with the confidence cliff (0.60-0.70 → 6/15 pts)
      // the old 6/10 was costing too many cumulative points and blocking valid stories.
      // Fix: set FRED_API_KEY / BLS_API_KEY / EIA_API_KEY in Vercel env for full 10/10.
      return {
        test: "Chart Quality",
        passed: true,
        score: 8,
        maxScore: 10,
        detail: `[REBUILD] topic "${article.topicKey}" requires chart but none generated (8/10 partial). Fix: set FRED_API_KEY / BLS_API_KEY / EIA_API_KEY.`,
      };
    }
    // Soft-fail in production: 6/10 partial credit instead of hard 0.
    // Hard 0 blocked 30-40% of macro articles when a single API key was
    // missing or a topic (e.g. "crypto", "earnings") had no chart mapping.
    // 6/10 still penalises significantly (-4 pts) but doesn't auto-reject.
    return {
      test: "Chart Quality",
      passed: false,
      score: 6,
      maxScore: 10,
      detail: `topic "${article.topicKey}" requires a chart but none was generated (6/10 soft-fail) — check API keys (FRED/BLS/EIA)`,
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

  // Production: must score ≥7/10 (was 5). Rebuild: ≥5 still passes (soft mode already applied above).
  const chartPassThreshold = REBUILD_MODE ? 5 : 7;

  return {
    test: "Chart Quality",
    passed: qaScore >= chartPassThreshold,
    score: qaScore,
    maxScore: 10,
    detail: qaScore < chartPassThreshold
      ? `internal chart score ${qaScore}/10 — minimum is ${chartPassThreshold}/10 (check data richness: need ≥6 data points, source attribution, time range)`
      : undefined,
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

  // Determine if same-cluster overlap within 24h
  const sameCluster24h = sameCluster && recentArticles.some((a) => {
    const age = articleTime - new Date(a.publishedAt).getTime();
    return age < 24 * 60 * 60 * 1000 &&
      getTopicCluster(a.topicKey ?? "") === articleCluster;
  });

  // Check if articles share the same eventId (tightest threshold)
  const sameEventId = article.eventId
    ? recentArticles.some((a) => a.eventId === article.eventId)
    : false;

  // Check if this is earnings-specific
  const isEarnings = article.category === "earnings" || article.topicKey === "earnings";

  // Dynamic thresholds (Section 11: same active event 50%, macro cluster 55%, earnings 60%)
  let hardRejectThreshold: number;
  let softWarnThreshold: number;

  if (sameEventId) {
    // Same active event — tightest threshold (50%)
    hardRejectThreshold = 0.50;
    softWarnThreshold   = 0.35;
  } else if (isEarnings) {
    // Earnings events — 60% threshold (company earnings repeat faster)
    hardRejectThreshold = 0.60;
    softWarnThreshold   = 0.45;
  } else if (sameCluster24h) {
    // Same macro cluster within 24h — 55% threshold
    hardRejectThreshold = 0.55;
    softWarnThreshold   = 0.40;
  } else {
    // Default: 55% hard reject, 40% soft warn
    hardRejectThreshold = 0.55;
    softWarnThreshold   = 0.40;
  }

  let score: number;
  let detail: string | undefined;

  const thresholdContext = sameEventId
    ? " (same event, 50% limit)"
    : isEarnings
    ? " (earnings, 60% limit)"
    : sameCluster24h
    ? " (same macro cluster <24h, 55% limit)"
    : "";

  if (maxSimilarity >= hardRejectThreshold) {
    score = 0;
    detail = `${Math.round(maxSimilarity * 100)}% similarity exceeds threshold${thresholdContext} — too similar to "${mostSimilarTitle.slice(0, 55)}..."`;
  } else if (maxSimilarity >= softWarnThreshold) {
    score = 3;
    detail = `${Math.round(maxSimilarity * 100)}% vocabulary overlap${thresholdContext} with "${mostSimilarTitle.slice(0, 55)}..."`;
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

  if (REBUILD_MODE) {
    // Softer penalties in rebuild mode — Claude naturally uses some filler idioms.
    // Production: 2+ fillers = 0 pts. Rebuild: 2 fillers = 2 pts, 3+ = 0.
    if (count === 0) {
      score = 5;
    } else if (count === 1) {
      score = 4;
      detail = `1 filler phrase (rebuild: -1pt)`;
    } else if (count === 2) {
      score = 2;
      detail = `2 filler phrases (rebuild: -3pts) — trim before promoting to production`;
    } else {
      score = 0;
      detail = `${count} filler phrases — rejected even in rebuild mode`;
    }
  } else {
    if (count === 0) {
      score = 5;
    } else if (count === 1) {
      score = 3;
      detail = `1 generic filler phrase detected in story body`;
    } else {
      score = 0;
      detail = `${count} generic filler phrases detected — editorial voice lacks precision`;
    }
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

// "concern", "expect", "watch", "uncertainty" were removed — they appear
// naturally in legitimate financial headlines (e.g. "Fed Concerns Lift Yields",
// "Apple Expects Strong Quarter") and were blocking valid stories.
const VAGUE_TITLE_PATTERNS = [
  /\bmarket[s]?\s+move[s]?\b/i,
  /\bstocks?\s+(rise|fall|move|shift)\b/i,
  /\bgeopoliti/i,
  /\bvolatil/i,
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

  // Story structure: ≥5 substantive paragraphs (5-section format) in production; ≥3 in rebuild
  const paragraphs = article.story
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 40);
  const minParas = REBUILD_MODE ? 3 : 5;
  if (paragraphs.length >= minParas) {
    score += 2;
  } else {
    details.push(`story has only ${paragraphs.length} paragraphs (need ≥${minParas} for 5-section format)`);
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
  } else if (confidence >= 0.58 && REBUILD_MODE) {
    // REBUILD_MODE bridge band: synthesis passes ≥0.58, but without this band a story
    // scoring 0.58–0.69 would fall to 6/15 — a 5-point cliff vs the 11 it needs to "pass".
    // Give 8/15 so it contributes meaningfully to the total without requiring production-
    // grade source corroboration during feed bootstrapping.
    score = 8;
    detail = `[REBUILD] confidence ${confidence} in bootstrap range (0.58–0.70); 8/15 partial credit`;
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

  // Story length: 2200 chars ≈ 400 words (5-section requirement) in production
  // Rebuild mode: 1500 chars ≈ 270 words (softer — still requires substance)
  const minChars = REBUILD_MODE ? 1500 : 2200;
  const minWords = REBUILD_MODE ? "≈270" : "≈400";

  if (article.story.length >= minChars) {
    score += 3;
  } else {
    details.push(`story body only ${article.story.length} chars (need ≥${minChars}, ${minWords} words for 5-section format)`);
  }

  // At least 3 numerical data points in story body (raised from 2 — 5 sections require more specifics)
  const numericalMatches = article.story.match(NUMERICAL_PATTERN);
  const minDataPoints = REBUILD_MODE ? 2 : 3;
  if ((numericalMatches?.length ?? 0) >= minDataPoints) {
    score += 2;
  } else {
    details.push(`story has only ${numericalMatches?.length ?? 0} data points (need ≥${minDataPoints})`);
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
// Update Language Detector — prevents incremental update articles
// ---------------------------------------------------------------------------

/**
 * Detects update-style language that indicates the article is an incremental
 * update to an ongoing story rather than a standalone analytical piece.
 *
 * Penalty-based: awards 0 bonus points but can impose a deduction of up to
 * -10 points from the total QA score. This is a hard quality gate.
 *
 * Update language patterns:
 *   - "continues to" / "remain elevated" / "still above" / "ongoing"
 *   - "as tensions persist" / "continues its climb"
 *   - Restating a thesis that could have been published yesterday
 */
const UPDATE_LANGUAGE_PATTERNS: RegExp[] = [
  /\bcontinues?\s+to\b/i,
  /\bcontinues?\s+(its?|their|the)\b/i,
  /\bremain[s]?\s+(elevated|high|low|above|below|near|steady|subdued|depressed|strong|weak)\b/i,
  /\bstill\s+(above|below|near|trading|holding|at)\b/i,
  /\bongoing\s+(tensions?|concerns?|pressure|volatility|uncertainty|conflict|crisis|disruption)\b/i,
  /\bpersist[s]?\b/i,
  /\bsustained\s+pressure\b/i,
  /\bextended\s+(rally|decline|selloff|sell-off|downturn|slide)\b/i,
  /\bfurther\s+(escalat|deteriorat|weaken|strengthen)/i,
  /\bdeepen(s|ed|ing)?\s+(the|its?|their)\b/i,
];

/** Phrases that indicate a genuine analytical use of these words, not update language */
const UPDATE_LANGUAGE_EXCEPTIONS: RegExp[] = [
  /\bcontinues?\s+to\s+(compress|widen|tighten|diverge|outperform|underperform)\b/i,
  /\bif\s+(tensions?|prices?|rates?)\s+remain\b/i,
  /\bshould\s+(tensions?|prices?|rates?)\s+(persist|remain|continue)\b/i,
];

function scoreUpdateLanguage(article: NewsItem): QATestResult {
  const text = article.title + " " + article.story + " " + (article.whyThisMatters ?? "");

  const matches: string[] = [];
  for (const pattern of UPDATE_LANGUAGE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      // Check if this match is actually an exception (analytical use)
      const isException = UPDATE_LANGUAGE_EXCEPTIONS.some((exc) => {
        // Check a 50-char window around the match for the exception pattern
        const idx = text.toLowerCase().indexOf(m[0].toLowerCase());
        const window = text.slice(Math.max(0, idx - 10), idx + 60);
        return exc.test(window);
      });
      if (!isException) {
        matches.push(m[0]);
      }
    }
  }

  // In REBUILD_MODE, skip the penalty entirely — we're bootstrapping the feed
  // and don't want this gate blocking otherwise-valid articles. The prompt-level
  // STANDALONE ARTICLE MANDATE and editorial self-critique still apply; the QA
  // penalty is production-only enforcement.
  if (REBUILD_MODE) {
    return {
      test: "Update Language",
      passed: true,
      score: 0,
      maxScore: 0,
      detail: matches.length > 0
        ? `[REBUILD] ${matches.length} update-language phrase(s) detected but not penalised in rebuild mode`
        : undefined,
    };
  }

  // Scoring: 0 matches = 0 penalty, 1 match = -3 penalty, 2+ = -7 penalty, 3+ = -10 penalty
  let penalty = 0;
  let detail: string | undefined;

  if (matches.length === 0) {
    // No update language — good
  } else if (matches.length === 1) {
    penalty = -3;
    detail = `1 update-language phrase detected: "${matches[0]}" — article may read as an incremental update`;
  } else if (matches.length === 2) {
    penalty = -7;
    detail = `2 update-language phrases detected: "${matches.slice(0, 2).join('", "')}" — article reads as an incremental update, not standalone analysis`;
  } else {
    penalty = -10;
    detail = `${matches.length} update-language phrases detected — article is an incremental update, not standalone analysis. Matches: "${matches.slice(0, 3).join('", "')}"`;
  }

  return {
    test: "Update Language",
    passed: penalty > -7,     // 1 instance is a warning, 2+ is a fail
    score: penalty,           // Negative score (penalty)
    maxScore: 0,              // No positive contribution
    detail,
  };
}

// ---------------------------------------------------------------------------
// Source coherence — validates sources are topically related to article
// ---------------------------------------------------------------------------

function scoreSourceCoherence(article: NewsItem): QATestResult {
  const STOP = new Set(["the","and","for","are","but","not","all","can","was","has","have","been","will","with","this","that","from","they","than","into","over","such","what","when","how","each","which","their","said","were","after","about","would","could","also","more","just","like","does","some","only","very"]);

  // Extract significant words from article title + story
  const articleText = `${article.title} ${article.story}`.toLowerCase();
  const articleWords = new Set(
    articleText.split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w))
  );

  const sources = article.sourcesUsed ?? [];
  if (sources.length === 0) {
    return { test: "Source Coherence", passed: false, score: 0, maxScore: 5, detail: "no sources listed" };
  }

  // For each source title, compute word overlap with article
  let coherentSources = 0;
  const incoherent: string[] = [];

  for (const src of sources) {
    const srcWords = (src.title ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w));
    const overlap = srcWords.filter((w) => articleWords.has(w)).length;
    const ratio = srcWords.length > 0 ? overlap / srcWords.length : 0;
    if (ratio >= 0.2) {
      coherentSources++;
    } else {
      incoherent.push(src.source);
    }
  }

  const coherenceRatio = coherentSources / sources.length;

  let score: number;
  let detail: string | undefined;

  if (coherenceRatio >= 0.8) {
    score = 5;
  } else if (coherenceRatio >= 0.6) {
    score = 3;
    detail = `${incoherent.length} source(s) have low topical relevance: ${incoherent.join(", ")}`;
  } else {
    score = 0;
    detail = `most sources (${incoherent.length}/${sources.length}) are topically unrelated to the article`;
  }

  return { test: "Source Coherence", passed: score >= 3, score, maxScore: 5, detail };
}

// ---------------------------------------------------------------------------
// Metadata validation — category, sentiment, tickers match content
// ---------------------------------------------------------------------------

function scoreMetadataAccuracy(article: NewsItem): QATestResult {
  let score = 0;
  const details: string[] = [];
  const lower = `${article.title} ${article.story}`.toLowerCase();

  // 1. Validate relatedTickers appear in the article text (2 pts)
  const tickers = article.relatedTickers ?? [];
  if (tickers.length > 0) {
    const tickersInText = tickers.filter((t) => {
      const tickerLower = t.toLowerCase();
      // Check for ticker symbol or common company name
      return lower.includes(tickerLower) || lower.includes(t);
    });
    if (tickersInText.length === tickers.length) {
      score += 2;
    } else if (tickersInText.length > 0) {
      score += 1;
      details.push(`${tickers.length - tickersInText.length} ticker(s) not found in article text`);
    } else {
      details.push(`none of the tickers [${tickers.join(",")}] appear in article text`);
    }
  } else {
    // Generic tags like MACRO, RATES are acceptable
    score += 1;
  }

  // 2. Validate sentiment matches content direction (2 pts)
  const posPatterns = [/\b(?:beat|surpass|exceed|rally|surge|gain|climb|raise|upgrade|bullish)\b/];
  const negPatterns = [/\b(?:cut|downgrade|decline|fall|drop|slump|miss|bearish|pressure|headwind|compress)\b/];
  const posHits = posPatterns.filter((p) => p.test(lower)).length;
  const negHits = negPatterns.filter((p) => p.test(lower)).length;

  const sentiment = article.sentiment ?? "neutral";
  if (sentiment === "positive" && negHits > posHits + 1) {
    details.push(`sentiment "positive" contradicts content (${negHits} negative vs ${posHits} positive signals)`);
  } else if (sentiment === "negative" && posHits > negHits + 1) {
    details.push(`sentiment "negative" contradicts content (${posHits} positive vs ${negHits} negative signals)`);
  } else {
    score += 2;
  }

  // 3. Validate marketImpact direction matches change sign AND format (1 pt)
  if (article.marketImpact && article.marketImpact.length > 0) {
    const inconsistent = article.marketImpact.filter((mi) => {
      if (mi.direction === "up" && mi.change.startsWith("-")) return true;
      if (mi.direction === "down" && mi.change.startsWith("+")) return true;
      return false;
    });
    // Validate change format: should be +/-NUMBER% or +/-NUMBERbps (pipeline standard)
    const VALID_CHANGE_FORMAT = /^[+\-]\d+[.,]?\d*\s*(%|bps|bp)$/i;
    const badFormat = article.marketImpact.filter(
      (mi) => !VALID_CHANGE_FORMAT.test(mi.change.trim())
    );
    if (inconsistent.length === 0 && badFormat.length === 0) {
      score += 1;
    } else {
      if (inconsistent.length > 0)
        details.push(`marketImpact direction/change mismatch for ${inconsistent.map((m) => m.asset).join(", ")}`);
      if (badFormat.length > 0)
        details.push(`marketImpact change format invalid for ${badFormat.map((m) => `${m.asset}="${m.change}"`).join(", ")} — expected +/-N.N% or +/-Nbps`);
    }
  } else {
    score += 1; // No marketImpact is acceptable (not all articles have it)
  }

  return {
    test: "Metadata Accuracy",
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
    scoreSourceCoherence(article),
    scoreMetadataAccuracy(article),
    scoreTitle(article.title),
    scoreThesisClarity(article),
    scoreChartQuality(article),
    scoreStoryCompleteness(article),
    scoreOriginality(article, existingArticles),
    scoreEditorialVoice(article),
    scoreImageQuality(article, existingArticles),
    scoreUpdateLanguage(article),
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
