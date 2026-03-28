/**
 * Type definitions for news aggregation feature
 */

export interface NewsSource {
  title: string;
  url: string;
  source: string; // e.g., "Reuters", "Bloomberg", "CNBC"
}

export interface KeyDataPoint {
  label: string;    // e.g., "Fed Funds Rate"
  value: string;    // e.g., "5.25–5.50%"
  change?: string;  // e.g., "+25bps" or "-0.3%"
  source?: string;  // e.g., "FRED", "Bloomberg"
}

/** A single named data series for multi-line/multi-bar charts */
export interface ChartSeries {
  name: string;                  // Legend label (e.g., "LULU", "S&P 500")
  values: number[];              // Same length as parent labels[]
  color?: string;                // Hex color override (auto-assigned if omitted)
}

export interface ChartDataset {
  title: string;
  type: "bar" | "line";
  labels: string[];              // x-axis labels (dates, tickers, etc.)
  values: number[];              // y-axis values (primary series — backward compatible)
  unit?: string;                 // e.g., "%" or "$B" or "bps"
  source: string;                // Data source attribution
  timeRange?: string;            // e.g., "Jan 2024 – Mar 2026"
  caption?: string;              // Editorial caption explaining macro relevance (shown below chart)
  chartLabel?: string;           // Header label above chart title (e.g., "Energy Markets", "Rates")
  insertAfterParagraph?: number; // 0-indexed paragraph after which this chart is injected
  referenceValue?: number;       // Optional benchmark line (e.g., 2.0 for Fed 2% target)
  referenceLabel?: string;       // Label for reference line (e.g., "Fed 2% Target")
  /** Multi-series data — when present, renders multiple lines/bars with a legend.
   *  The primary `values` field is ignored when `series` is set. */
  series?: ChartSeries[];
}

// ---------------------------------------------------------------------------
// Market Impact — per-article asset impact display
// ---------------------------------------------------------------------------

export interface MarketImpactItem {
  asset: string;      // e.g., "OIL", "S&P 500", "10Y Yield", "BTC"
  change: string;     // e.g., "+4.1%", "-1.2%", "+8bps"
  direction: "up" | "down" | "flat";
}

// ---------------------------------------------------------------------------
// News Event — event-first architecture grouping related articles
// ---------------------------------------------------------------------------

export interface NewsEvent {
  id: string;                        // Canonical event ID (e.g. "fed-rate-decision-mar-2026")
  topicKey: string;                  // Matches NewsItem.topicKey (e.g. "federal_reserve")
  title: string;                     // Human-readable event name
  status: "active" | "cooling" | "closed"; // active=breaking, cooling=24-48h old, closed=resolved
  startedAt: string;                 // ISO 8601 — when event first published
  lastActivityAt: string;            // ISO 8601 — most recent update
  leadArticleId: string;             // ID of the canonical lead article
  relatedAssets: string[];           // e.g., ["SPY", "TLT", "USD"]
  updateCount: number;               // Number of articles covering this event
}

export interface NewsItem {
  id: string; // UUID or hash of story
  title: string;
  story: string; // Main synthesized narrative
  category: "macro" | "earnings" | "markets" | "policy" | "crypto" | "other";
  publishedAt: string; // ISO 8601 timestamp
  importance: number; // 1-10 score
  sentiment?: "positive" | "negative" | "neutral";
  relatedTickers?: string[]; // e.g., ["SPY", "^GSPC", "BTC-USD"]
  sourcesUsed: NewsSource[]; // Original articles combined for synthesis
  synthesizedBy?: string;  // Internal field — not rendered publicly
  factCheckScore: number; // 0-100, confidence in accuracy
  verifiedClaims: string[]; // List of specific facts verified
  topicKey?: string; // Canonical topic bucket (e.g. "federal_reserve") — used for cross-run dedup
  failureReason?: string; // If story was rejected
  imageUrl?: string; // Unsplash photo URL

  // Editorial enrichment fields
  whyThisMatters?: string;         // One-sentence significance explanation for homepage cards
  whatToWatchNext?: string;        // Forward-looking signal for investors
  secondOrderImplication?: string; // Beyond-the-headline market impact
  keyDataPoints?: KeyDataPoint[];  // Important numbers with sources
  chartData?: ChartDataset[];      // Optional charts for data-driven stories (up to 3)
  keyTakeaways?: string[];         // 3-bullet editorial summary (displayed below headline)
  confidenceScore?: number;        // 0–1 editorial confidence gate (≥ 0.70 required to publish)

  // Multi-layer fact-check results
  dataVerificationScore?: number;  // 0–100 from data-backed verification (FRED/BLS/EIA cross-ref)
  sourceAlignmentScore?: number;   // 0–100 from source-alignment check (hallucination detection)
  dataVerificationDetails?: string; // Human-readable summary of data verification results
  hallucinations?: string[];       // Claims not grounded in any source article

  // Geopolitical themes (structured tags from synthesis, replaces regex detection)
  geoThemes?: string[];            // e.g., ["iran_oil_supply", "us_china_trade"]

  // Event-first architecture
  eventId?: string;                // Links article to a NewsEvent (optional)
  marketImpact?: MarketImpactItem[]; // Asset-level impact strip (e.g., OIL +4.1%, S&P -1.2%)
  wordCount?: number;              // Approximate word count of story body
  /** Optional inline image inserted mid-article for visual variety */
  inlineImageUrl?: string;
  inlineImageCaption?: string;
  inlineImagePosition?: number;    // insertAfterParagraph index
}

export interface NewsCollection {
  lastUpdated: string; // ISO 8601 timestamp
  source: string; // "Finnhub + NewsAPI (synthesized via Claude, fact-checked)"
  news: NewsItem[];
  meta: {
    totalCount: number;
    nextUpdate: string;
    archiveUrl?: string;
  };
}

export interface ArchivedNewsCollection {
  lastUpdated: string;
  archivedNews: Array<
    NewsItem & {
      archivedAt: string;
    }
  >;
  meta: {
    totalCount: number;
    oldestStory: string;
    newestStory: string;
  };
}

// ---------------------------------------------------------------------------
// Daily Briefing
// ---------------------------------------------------------------------------

export interface DailyBriefing {
  date: string;          // YYYY-MM-DD
  generatedAt: string;   // ISO 8601
  leadStory: {
    id: string;
    title: string;
    whyItMatters: string;
    summary: string;
  };
  topDevelopments: Array<{
    id: string;
    headline: string;
    summary: string;
    category: NewsItem["category"];
  }>;
  keyData: KeyDataPoint[];
  whatToWatch: Array<{
    event: string;
    timing: string;
    significance: string;
    watchMetric?: string;   // e.g., "10-Year Treasury above 4.30%"
  }>;
  storiesPublished: number;
  generatedFrom: string[]; // Story IDs used to generate briefing
  /** Follow-up on yesterday's briefing items — tracks editorial continuity */
  followUpItems?: Array<{
    originalEvent: string;   // From yesterday's whatToWatch
    originalDate: string;    // YYYY-MM-DD
    outcome: string;         // What actually happened
  }>;
}

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface FinnhubArticle {
  headline?: string;
  summary?: string;
  url?: string;
  source?: string;
  datetime?: number; // Unix timestamp
  category?: string;
  image?: string;
  related?: string[];
}

/**
 * RSS articles are normalized into FinnhubArticle shape so they flow through
 * the existing pipeline (filterByAge, filterByRelevance, deduplicateNews, etc.)
 * without any downstream changes.
 *
 * The `source` field carries the canonical outlet name (e.g. "Reuters") which
 * is matched against TIER_1_SOURCES / TIER_2_SOURCES in news.ts automatically.
 * Author attribution (when present) is stored as "author:<name>" in `related`.
 *
 * This type alias exists purely for documentation; at runtime it is identical
 * to FinnhubArticle.
 */
export type RssArticle = FinnhubArticle;

export interface NewsAPIArticle {
  source: {
    id: string | null;
    name: string;
  };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string; // ISO 8601
  content: string;
}

export interface FactCheckResult {
  claim: string;
  verified: boolean;
  confidence: number; // 0-100
  sources?: string[]; // URLs of fact-check articles
  explanation?: string;
}

export interface SynthesisInput {
  relatedArticles: (FinnhubArticle | NewsAPIArticle)[];
  category: NewsItem["category"];
  importance: number;
}

export interface RawNews {
  finnhub: FinnhubArticle[];
  newsapi: NewsAPIArticle[];
}

export interface GroupedNews {
  topic: string; // e.g., "Federal Reserve Rate Decision"
  category: NewsItem["category"];
  articles: Array<FinnhubArticle | NewsAPIArticle>;
  importance: number;
}

// Type guards
export function isFinnhubArticle(article: unknown): article is FinnhubArticle {
  return (
    typeof article === "object" &&
    article !== null &&
    ("headline" in article || "summary" in article)
  );
}

export function isNewsAPIArticle(article: unknown): article is NewsAPIArticle {
  return (
    typeof article === "object" &&
    article !== null &&
    "source" in article &&
    typeof (article as Record<string, unknown>).source === "object" &&
    "name" in ((article as Record<string, unknown>).source as Record<string, unknown>)
  );
}

export function isNewsItem(item: unknown): item is NewsItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "id" in item &&
    "title" in item &&
    "story" in item &&
    "category" in item
  );
}

// ---------------------------------------------------------------------------
// Market Signals
// ---------------------------------------------------------------------------

export interface MarketSignal {
  id: string;
  signal: string;                                    // One-sentence signal statement
  direction: "bullish" | "bearish" | "neutral";
  asset: string;                                     // e.g., "S&P 500", "Oil", "Bitcoin", "Bonds"
  timeframe: string;                                 // e.g., "Near-term", "1–2 weeks"
  confidence: "high" | "medium" | "low";
  generatedAt: string;                               // ISO 8601
}

export interface SignalsCollection {
  signals: MarketSignal[];
  generatedAt: string;   // ISO 8601
  validUntil: string;    // ISO 8601 — 1h TTL
}

// ---------------------------------------------------------------------------
// Macro Board
// ---------------------------------------------------------------------------

export interface MacroIndicator {
  label: string;         // e.g., "Fed Funds Rate"
  value: string;         // e.g., "4.25–4.50%"
  change?: string;       // e.g., "-25bps"
  direction: "up" | "down" | "flat";
  source: string;        // e.g., "FRED"
  updatedAt: string;     // ISO 8601
}

export interface RegimeDimensions {
  inflation: string;   // "Above Target" | "Persistent" | "Near Target" | "Disinflating"
  policy: string;      // "Restrictive" | "Accommodative" | "Easing" | "Tightening" | "Neutral"
  growth: string;      // "Solid" | "Moderating" | "Slowing"
  liquidity: string;   // "Tightening" | "Tight" | "Neutral" | "Easing" | "Accommodative"
}

export interface MacroBoardData {
  indicators: MacroIndicator[];
  regime: string;                     // e.g., "Policy Restrictive, Disinflation Trend"
  regimeTags: string[];               // e.g., ["Policy Restrictive", "Disinflation Trend"]
  regimeDimensions?: RegimeDimensions; // structured 4-axis regime snapshot
  generatedAt: string;                // ISO 8601
  validUntil: string;                 // ISO 8601 — 15min TTL
}

// ---------------------------------------------------------------------------
// Market Snapshot Strip — live price data for homepage strip
// ---------------------------------------------------------------------------

export interface MarketSnapshotItem {
  label: string;         // e.g., "S&P 500", "BTC", "10Y Yield"
  value: string;         // e.g., "5,234", "67,800", "4.28%"
  change: string;        // e.g., "+1.2%", "-0.4%", "+6bps"
  direction: "up" | "down" | "flat";
  source: string;        // e.g., "FMP", "FRED", "EIA"
}

export interface MarketSnapshotData {
  items: MarketSnapshotItem[];
  generatedAt: string;   // ISO 8601
  validUntil: string;    // ISO 8601 — 60s TTL for strip
}

// ---------------------------------------------------------------------------
// Market Prices — 5-item dashboard section (S&P 500, VIX, WTI, DXY, BTC)
// Superset of snapshot with trading-session metadata for smart client refresh
// ---------------------------------------------------------------------------

export interface MarketPricesData {
  items: MarketSnapshotItem[];
  sessionStatus: "open" | "extended" | "closed";
  refreshIntervalMs: number;  // Suggested client poll interval in ms
  generatedAt: string;        // ISO 8601
  validUntil: string;         // ISO 8601 — 60s TTL
}

// ---------------------------------------------------------------------------
// Market Sparklines — 30-day daily trendlines for key market indicators
// ---------------------------------------------------------------------------

export interface SparklineSet {
  label: string;    // "S&P 500", "VIX", "WTI Oil", "Dollar Index", "Bitcoin"
  points: number[]; // Chronological price values (oldest → newest)
}

export interface MarketSparklinesData {
  sparklines: SparklineSet[];
  generatedAt: string;  // ISO 8601
  validUntil: string;   // ISO 8601 — 15-min TTL
}
