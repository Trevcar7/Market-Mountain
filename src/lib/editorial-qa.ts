/**
 * Editorial Quality Assurance Gate — v3
 *
 * Runs a comprehensive quality score on every synthesized article.
 * Raw points are normalized to a 0–100 scale before threshold comparison.
 * Only articles scoring ≥ QA_PASS_THRESHOLD may be published.
 *
 * Scoring breakdown (18 tests, normalized to 100):
 *   Story Worthiness    (15) — market impact, catalyst chain, investor implication
 *   Confidence          (15) — composite editorial confidence score
 *   Fact Check          (10) — claim verification score (heuristic/Google)
 *   Source Quality      (10) — Tier 1 source presence + corroboration
 *   Source Coherence     (5) — sources topically relevant to article
 *   Metadata Accuracy    (5) — tickers, sentiment, marketImpact consistency
 *   Title Quality       (10) — word count, specificity, no vague language
 *   Thesis Clarity      (10) — four editorial questions answered
 *   Section Headings     (5) — enforces 5-section ## heading structure
 *   Key Takeaways        (5) — 3 distinct, specific takeaways with numbers
 *   Chart Quality       (10) — mandatory for key topics; internal quality score
 *   Story Completeness   (5) — length (≥120 words) + numerical grounding
 *   Originality          (5) — language similarity vs. recent articles
 *   Editorial Voice      (5) — no generic filler phrases
 *   Image Quality        (5) — unique, relevant image
 *   Update Language      (0) — penalty-only (-10 for "update" phrasing)
 *   Data Verification   (10) — cross-references claims vs FRED/BLS/EIA live data
 *   Source Alignment     (8) — verifies synthesized claims are grounded in sources
 *
 * Production threshold: 93 / 100 (A+ quality — 10/10 in every category)
 * Rebuild mode threshold: 72 / 100 (set REBUILD_MODE=true in env)
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
 * Production: 93 | Rebuild mode: 72
 *
 * A+ quality standard: articles must score near-perfect on every test.
 * Fact check hard floor: 90 (requires Google Fact Check API + data verification).
 * Confidence hard floor: 0.80 (requires strong source corroboration).
 * Data verification hard floor: 70 (requires strong numerical accuracy).
 *
 * Why 72 in rebuild:
 *   - Chart soft-fail costs up to 4 pts when FRED/BLS/EIA keys are missing
 *   - Confidence band 0.58–0.70 costs up to 5 pts vs production scoring
 *   - Together these two penalties can drop a strong story from ~83 to ~74
 *   - Threshold 72 gives enough headroom while still blocking thin content
 */
export const QA_PASS_THRESHOLD = REBUILD_MODE ? 72 : 93;

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
    passed: score >= 13,
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

/**
 * Banned headline words — per geopolitical restraint rule (Step 16f) and
 * editorial language standards (Step 14). These words in headlines risk
 * sensationalism and editorial liability. Only allowed if directly quoting
 * an official source (which headlines never do).
 */
const HEADLINE_BANNED_WORDS = [
  /\bwar\b/i,
  /\bcrisis\b/i,
  /\bcollapse[sd]?\b/i,
  /\bcatastroph/i,
  /\bunprecedented\b/i,
  /\bgame.?changer\b/i,
  /\bparadigm\s+shift\b/i,
  /\bparabolic\b/i,
];

function scoreTitle(title: string): QATestResult {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  let score = 0;
  const details: string[] = [];

  // 3 pts for ideal 8–14 word range; 1 pt for acceptable 6–16
  if (wordCount >= 8 && wordCount <= 14) {
    score += 3;
  } else if (wordCount >= 6 && wordCount <= 16) {
    score += 1;
    details.push(`title has ${wordCount} words (ideal: 8–14)`);
  } else {
    details.push(`title word count ${wordCount} outside acceptable range (8–14)`);
  }

  // 3 pts: specificity — number, ticker, or named entity
  const hasSpecificity = SPECIFICITY_PATTERNS.some((p) => p.test(title));
  if (hasSpecificity) {
    score += 3;
  } else {
    details.push("title lacks specific number or named entity");
  }

  // 2 pts: no vague language
  const vagueMatch = VAGUE_TITLE_PATTERNS.find((p) => p.test(title));
  if (!vagueMatch) {
    score += 2;
  } else {
    details.push(`title contains vague language matching "${vagueMatch.source}"`);
  }

  // 2 pts: no banned words (war, crisis, collapse, catastrophe, etc.)
  const bannedMatch = HEADLINE_BANNED_WORDS.find((p) => p.test(title));
  if (!bannedMatch) {
    score += 2;
  } else {
    details.push(`title contains banned word "${title.match(bannedMatch)?.[0]}" — use measured language per editorial standards`);
  }

  return {
    test: "Title Quality",
    passed: score >= 8,
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
    passed: score >= 9,
    score,
    maxScore: 10,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Section Headings — enforces 5-section format with ## headings
// ---------------------------------------------------------------------------

function scoreSectionHeadings(article: NewsItem): QATestResult {
  const headingMatches = article.story.match(/^## .+/gm) ?? [];
  const headingCount = headingMatches.length;
  let score = 0;
  const details: string[] = [];

  if (headingCount >= 5) {
    score = 5;
  } else if (headingCount >= 3) {
    score = 3;
    details.push(`only ${headingCount} section headings (need ≥5 for 5-section format)`);
  } else if (headingCount >= 1) {
    score = 1;
    details.push(`only ${headingCount} section heading(s) — article lacks proper structure`);
  } else {
    score = 0;
    details.push("no section headings (## ) found — article lacks any structure");
  }

  return {
    test: "Section Headings",
    passed: score >= 3,
    score,
    maxScore: 5,
    detail: details.length > 0 ? details.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Key Takeaways Quality — uniqueness, specificity, no repetition
// ---------------------------------------------------------------------------

function scoreKeyTakeawaysQuality(article: NewsItem): QATestResult {
  const takeaways = article.keyTakeaways ?? [];
  let score = 0;
  const details: string[] = [];

  if (takeaways.length === 0) {
    return {
      test: "Key Takeaways",
      passed: false,
      score: 0,
      maxScore: 5,
      detail: "no key takeaways present",
    };
  }

  // 2 pts: have 3 takeaways
  if (takeaways.length >= 3) {
    score += 2;
  } else {
    score += 1;
    details.push(`only ${takeaways.length} takeaway(s) — need 3`);
  }

  // 2 pts: takeaways are distinct (low pairwise overlap)
  const STOP = new Set(["the","and","for","are","but","not","all","can","was","has","have","been","will","with","this","that","from","they","than","into","over","said","were","after","about","would","could","also","more","just","like","does","some","only"]);
  const wordSets = takeaways.map((t) =>
    new Set(t.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w)))
  );

  let maxOverlap = 0;
  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const intersection = [...wordSets[i]].filter((w) => wordSets[j].has(w)).length;
      const smaller = Math.min(wordSets[i].size, wordSets[j].size);
      const overlap = smaller > 0 ? intersection / smaller : 0;
      maxOverlap = Math.max(maxOverlap, overlap);
    }
  }

  if (maxOverlap < 0.4) {
    score += 2;
  } else if (maxOverlap < 0.6) {
    score += 1;
    details.push(`takeaways have ${Math.round(maxOverlap * 100)}% word overlap — could be more distinct`);
  } else {
    details.push(`takeaways are repetitive (${Math.round(maxOverlap * 100)}% word overlap)`);
  }

  // 1 pt: at least one takeaway contains a number (specificity)
  const hasNumber = takeaways.some((t) => /\d/.test(t));
  if (hasNumber) {
    score += 1;
  } else {
    details.push("no takeaway contains a specific number");
  }

  return {
    test: "Key Takeaways",
    passed: score >= 3,
    score,
    maxScore: 5,
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
    passed: score >= 9,
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
    passed: score >= 13,
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
    passed: score >= 9,
    score,
    maxScore: 10,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Data Verification — cross-reference against live FRED/BLS/EIA data
// ---------------------------------------------------------------------------

function scoreDataVerification(article: NewsItem): QATestResult {
  const dvScore = article.dataVerificationScore;
  let score = 0;
  let detail: string | undefined;

  if (dvScore === undefined || dvScore === null) {
    // No data verification ran (no numeric claims found) — neutral
    score = 5;
    detail = "no verifiable numeric claims found";
  } else if (dvScore >= 90) {
    score = 10;
    detail = article.dataVerificationDetails;
  } else if (dvScore >= 70) {
    score = 8;
    detail = `data verification score ${dvScore} — ${article.dataVerificationDetails ?? ""}`;
  } else if (dvScore >= 55) {
    score = 5;
    detail = `data verification score ${dvScore} — some claims could not be verified`;
  } else {
    score = 0;
    detail = `data verification score ${dvScore} — numerical claims may be inaccurate`;
  }

  return {
    test: "Data Verification",
    passed: score >= 8,
    score,
    maxScore: 10,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Source Alignment — hallucination detection
// ---------------------------------------------------------------------------

function scoreSourceAlignment(article: NewsItem): QATestResult {
  const saScore = article.sourceAlignmentScore;
  let score = 0;
  let detail: string | undefined;

  if (saScore === undefined || saScore === null) {
    // No source alignment ran — neutral
    score = 4;
    detail = "source alignment check was not performed";
  } else if (saScore >= 90) {
    score = 8;
    detail = "all claims grounded in source articles";
  } else if (saScore >= 70) {
    score = 6;
    detail = `source alignment ${saScore} — mostly grounded`;
  } else if (saScore >= 50) {
    score = 3;
    detail = `source alignment ${saScore} — some claims not grounded in sources`;
  } else {
    score = 0;
    const hallCount = article.hallucinations?.length ?? 0;
    detail = `source alignment ${saScore} — ${hallCount} ungrounded claims detected`;
  }

  return {
    test: "Source Alignment",
    passed: score >= 6,
    score,
    maxScore: 8,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Image quality & relevance
// ---------------------------------------------------------------------------

/**
 * Known Unsplash photo IDs per topic — used to verify image relevance.
 * Each topic key maps to expected Unsplash photo ID substrings that are editorially approved.
 * If an article's image doesn't match its topic's expected images, it's flagged as generic.
 */
const TOPIC_IMAGE_IDS: Record<string, string[]> = {
  federal_reserve: ["1569025591598"],
  fed_macro:       ["1569025591598"],
  inflation:       ["1556742049"],
  gdp:             ["1477959858617"],
  employment:      ["1521737711867"],
  trade_policy:    ["1494412574643"],
  trade_policy_tariff: ["1494412574643"],
  broad_market:    ["1611974789855"],
  crypto:          ["1518546305927"],
  bankruptcy:      ["1507679799987"],
  merger_acquisition: ["1521791136064"],
  bond_market:     ["1604594849809"],
  energy:          ["1466611653911"],
  earnings:        ["1590283603385"],
  layoffs:         ["1486312338219"],
  ipo:             ["1611974789855"],
  nvidia:          ["1587202372775"],
};

/**
 * Keywords expected in article titles/stories for each topic — used to validate
 * that the image topic assignment actually matches the article content.
 */
const TOPIC_CONTENT_KEYWORDS: Record<string, RegExp> = {
  federal_reserve: /\b(fed|federal reserve|fomc|rate|powell|monetary)\b/i,
  fed_macro:       /\b(fed|federal reserve|fomc|rate|powell|monetary)\b/i,
  inflation:       /\b(cpi|ppi|inflation|price|deflat)\b/i,
  gdp:             /\b(gdp|growth|economic output|recession)\b/i,
  employment:      /\b(job|employment|payroll|unemployment|labor|hiring|layoff)\b/i,
  trade_policy:    /\b(tariff|trade|import|export|customs|duty|wto)\b/i,
  trade_policy_tariff: /\b(tariff|trade|import|export|customs|duty)\b/i,
  broad_market:    /\b(s&p|nasdaq|dow|market|index|rally|selloff)\b/i,
  crypto:          /\b(bitcoin|btc|ethereum|crypto|blockchain|defi|token)\b/i,
  energy:          /\b(oil|crude|wti|brent|opec|energy|petroleum|natural gas)\b/i,
  earnings:        /\b(earnings|revenue|profit|eps|quarter|fiscal|beat|miss)\b/i,
  nvidia:          /\b(nvidia|nvda|gpu|chip|blackwell|jensen)\b/i,
  merger_acquisition: /\b(acqui|merger|m&a|takeover|buyout|deal)\b/i,
  bankruptcy:      /\b(bankrupt|chapter\s*11|restructur|insolvenc)\b/i,
  ipo:             /\b(ipo|listing|public offering|debut)\b/i,
  bond_market:     /\b(treasury|bond|yield|fixed income|tlt|dgs10)\b/i,
  layoffs:         /\b(layoff|cut|downsiz|restructur|workforce reduc)\b/i,
};

function scoreImageQuality(article: NewsItem, existingArticles: NewsItem[]): QATestResult {
  let score = 0;
  const details: string[] = [];

  // 1. Valid HTTP URL present (+2)
  if (article.imageUrl && article.imageUrl.startsWith("http")) {
    score += 2;
  } else {
    details.push("no image URL");
  }

  // 2. Uniqueness — not duplicated across feed (+1)
  if (article.imageUrl) {
    const baseUrl = article.imageUrl.split("?")[0];
    const isDuplicate = existingArticles.some(
      (ex) => ex.imageUrl && ex.imageUrl.split("?")[0] === baseUrl
    );
    if (!isDuplicate) {
      score += 1;
    } else {
      details.push("image URL already used by another article");
    }
  }

  // 3. Topic relevance — image should match article's topic/content (+2)
  if (article.imageUrl && article.topicKey) {
    const topicKey = article.topicKey;
    const expectedIds = TOPIC_IMAGE_IDS[topicKey];
    const contentPattern = TOPIC_CONTENT_KEYWORDS[topicKey];
    const articleText = `${article.title} ${article.story?.substring(0, 500) ?? ""}`;

    if (expectedIds) {
      // Check if image is from the expected topic's curated set
      const imageMatchesTopic = expectedIds.some((id) => article.imageUrl!.includes(id));
      if (imageMatchesTopic) {
        score += 2;
      } else {
        // Image doesn't match expected topic — check if content actually matches topic
        if (contentPattern && contentPattern.test(articleText)) {
          details.push(`image does not match topic "${topicKey}" — may be generic or mis-assigned`);
        } else {
          // Topic itself may be wrong — partial credit
          score += 1;
          details.push(`topic "${topicKey}" may not match article content — image relevance unclear`);
        }
      }
    } else {
      // Unknown topic — partial credit if URL is valid
      score += 1;
    }
  } else if (article.imageUrl) {
    // No topicKey — can't validate relevance, partial credit
    score += 1;
  }

  return {
    test: "Image Quality",
    passed: score >= 4,
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

/** Crypto-specific source domains — penalize when used for non-crypto articles */
const CRYPTO_SOURCE_DOMAINS = new Set([
  "coindesk", "cointelegraph", "decrypt", "the block", "bitcoin magazine",
  "cryptoslate", "bitcoinist", "u.today", "newsbtc", "ambcrypto",
]);

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

  // ── Cross-sector ticker detection ──
  const articleTickers = new Set(
    (article.relatedTickers ?? []).map((t) => t.toUpperCase())
  );
  const foreignTickerSources: string[] = [];
  const TICKER_RE = /\b([A-Z]{2,5})\b/g;

  for (const src of sources) {
    const srcTitle = src.title ?? "";
    const matches = [...srcTitle.matchAll(TICKER_RE)].map((m) => m[1]);
    for (const ticker of matches) {
      if (["THE","AND","FOR","ARE","BUT","NOT","ALL","CAN","WAS","HAS","ITS","CEO","GDP","CPI","IPO","ETF","SEC","FED","USA","FBI","FDA"].includes(ticker)) continue;
      if (articleTickers.size > 0 && !articleTickers.has(ticker) && !articleText.includes(ticker.toLowerCase())) {
        foreignTickerSources.push(`${src.source} (ticker ${ticker} not in article)`);
        break;
      }
    }
  }

  // ── Crypto source domain penalization ──
  // Flag crypto-specific sources (CoinDesk, CoinTelegraph, etc.) used in non-crypto articles
  const isCryptoArticle = article.category === "crypto" ||
    article.topicKey === "crypto" ||
    /\b(bitcoin|crypto|ethereum|blockchain)\b/i.test(articleText);

  const cryptoSources: string[] = [];
  if (!isCryptoArticle) {
    for (const src of sources) {
      const srcLower = src.source.toLowerCase();
      if (CRYPTO_SOURCE_DOMAINS.has(srcLower) || [...CRYPTO_SOURCE_DOMAINS].some((d) => srcLower.includes(d))) {
        cryptoSources.push(src.source);
      }
    }
  }

  // For each source title, compute word overlap with article
  let coherentSources = 0;
  const incoherent: string[] = [];

  for (const src of sources) {
    const srcWords = (src.title ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w));
    const overlap = srcWords.filter((w) => articleWords.has(w)).length;
    const ratio = srcWords.length > 0 ? overlap / srcWords.length : 0;
    if (ratio >= 0.25) {
      coherentSources++;
    } else {
      incoherent.push(src.source);
    }
  }

  const coherenceRatio = coherentSources / sources.length;

  let score: number;
  let detail: string | undefined;

  if (coherenceRatio >= 0.8 && foreignTickerSources.length === 0 && cryptoSources.length === 0) {
    score = 5;
  } else if (foreignTickerSources.length > 0) {
    score = 1;
    detail = `cross-sector source contamination: ${foreignTickerSources.join("; ")}`;
  } else if (cryptoSources.length > 0) {
    score = 2;
    detail = `crypto-specific source(s) used in non-crypto article: ${cryptoSources.join(", ")}`;
  } else if (coherenceRatio >= 0.6) {
    score = 3;
    detail = `${incoherent.length} source(s) have low topical relevance: ${incoherent.join(", ")}`;
  } else {
    score = 0;
    detail = `most sources (${incoherent.length}/${sources.length}) are topically unrelated to the article`;
  }

  return { test: "Source Coherence", passed: score >= 4, score, maxScore: 5, detail };
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

  // 3. Validate marketImpact direction, format, AND asset relevance (1 pt)
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
    // Validate that marketImpact assets appear in the article text
    const ASSET_ALIASES: Record<string, string[]> = {
      "OIL": ["oil", "crude", "wti", "brent", "petroleum"],
      "WTI": ["oil", "crude", "wti", "brent"],
      "S&P 500": ["s&p", "spy", "equities", "equity", "stock market"],
      "SPY": ["s&p", "spy", "equities", "stock market"],
      "10Y YIELD": ["yield", "treasury", "10-year", "bond"],
      "BTC": ["bitcoin", "btc", "crypto"],
      "GOLD": ["gold", "gld", "safe haven"],
      "DXY": ["dollar", "dxy", "greenback", "usd"],
      "VIX": ["vix", "volatility", "fear"],
    };
    const missingAssets = article.marketImpact.filter((mi) => {
      const assetUpper = mi.asset.toUpperCase();
      const aliases = ASSET_ALIASES[assetUpper] ?? [mi.asset.toLowerCase()];
      return !aliases.some((alias) => lower.includes(alias));
    });

    if (inconsistent.length === 0 && badFormat.length === 0 && missingAssets.length === 0) {
      score += 1;
    } else {
      if (inconsistent.length > 0)
        details.push(`marketImpact direction/change mismatch for ${inconsistent.map((m) => m.asset).join(", ")}`);
      if (badFormat.length > 0)
        details.push(`marketImpact change format invalid for ${badFormat.map((m) => `${m.asset}="${m.change}"`).join(", ")} — expected +/-N.N% or +/-Nbps`);
      if (missingAssets.length > 0)
        details.push(`marketImpact asset(s) not mentioned in article: ${missingAssets.map((m) => m.asset).join(", ")}`);
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
    scoreSectionHeadings(article),
    scoreKeyTakeawaysQuality(article),
    scoreChartQuality(article),
    scoreStoryCompleteness(article),
    scoreOriginality(article, existingArticles),
    scoreEditorialVoice(article),
    scoreImageQuality(article, existingArticles),
    scoreUpdateLanguage(article),
    scoreDataVerification(article),
    scoreSourceAlignment(article),
  ];

  const rawScore = tests.reduce((sum, t) => sum + t.score, 0);
  const maxPossible = tests.reduce((sum, t) => sum + t.maxScore, 0);
  // Normalize to 0–100 scale so thresholds stay meaningful regardless of test count
  const score = maxPossible > 0 ? Math.round((rawScore / maxPossible) * 100) : 0;
  let passed = score >= QA_PASS_THRESHOLD;

  // ---------------------------------------------------------------------------
  // Hard-reject floors — critical quality metrics that MUST meet minimum bars
  // regardless of overall score. Prevents low-integrity articles from passing
  // via high scores on softer tests (voice, title, completeness).
  // ---------------------------------------------------------------------------
  const hardRejectReasons: string[] = [];

  // Fact check: hard floor applies in ALL modes (production=90, rebuild=35)
  // Only publish articles with very high fact-check confidence.
  const FC_HARD_FLOOR = REBUILD_MODE ? 35 : 90;
  const fc = article.factCheckScore ?? 0;
  if (fc < FC_HARD_FLOOR) {
    hardRejectReasons.push(`factCheckScore=${fc} < ${FC_HARD_FLOOR} minimum`);
  }

  // Headline banned words: hard reject in all modes (editorial integrity)
  const titleTest = tests.find((t) => t.test === "Title Quality");
  if (titleTest && titleTest.detail?.includes("banned word")) {
    hardRejectReasons.push(`headline contains banned word — ${titleTest.detail}`);
  }

  if (!REBUILD_MODE) {
    // Confidence: < 0.80 means insufficient source corroboration
    const conf = article.confidenceScore ?? 0;
    if (conf < 0.80) {
      hardRejectReasons.push(`confidenceScore=${conf} < 0.80 minimum`);
    }

    // Source coherence: 0/5 means sources are topically unrelated to article
    const coherenceTest = tests.find((t) => t.test === "Source Coherence");
    if (coherenceTest && coherenceTest.score === 0) {
      hardRejectReasons.push("source coherence score is 0 — sources unrelated to article content");
    }

    // Ticker integrity: if tickers are listed but NONE appear in article text, hard reject
    const metadataTest = tests.find((t) => t.test === "Metadata Accuracy");
    const tickers = article.relatedTickers ?? [];
    if (tickers.length > 0 && metadataTest) {
      const lower = `${article.title} ${article.story}`.toLowerCase();
      const tickersInText = tickers.filter((t) => lower.includes(t.toLowerCase()) || lower.includes(t));
      if (tickersInText.length === 0) {
        hardRejectReasons.push(`none of relatedTickers [${tickers.join(",")}] appear in article text`);
      }
    }

    // Data verification: hard reject if score < 70 (requires strong numerical accuracy)
    const dvScore = article.dataVerificationScore;
    if (dvScore !== undefined && dvScore !== null && dvScore < 70) {
      hardRejectReasons.push(`dataVerificationScore=${dvScore} < 70 — numerical claims insufficiently verified`);
    }

    // Source alignment: hard reject if too many hallucinations detected
    const hallCount = article.hallucinations?.length ?? 0;
    if (hallCount >= 3) {
      hardRejectReasons.push(`${hallCount} ungrounded claims detected — possible hallucinations`);
    }
  }

  if (hardRejectReasons.length > 0) {
    passed = false;
  }

  let rejectionReason: string | undefined;
  if (!passed) {
    const failedTests = tests
      .filter((t) => !t.passed)
      .map(
        (t) =>
          `${t.test} (${t.score}/${t.maxScore}${t.detail ? `: ${t.detail}` : ""})`
      )
      .join("; ");

    if (hardRejectReasons.length > 0) {
      rejectionReason = `HARD REJECT: ${hardRejectReasons.join("; ")}. QA score ${score}/100. Failed tests: ${failedTests}`;
    } else {
      rejectionReason = `QA score ${score}/100 < ${QA_PASS_THRESHOLD} minimum. Failed: ${failedTests}`;
    }
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
