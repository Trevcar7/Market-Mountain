import Anthropic from "@anthropic-ai/sdk";
import { GroupedNews, NewsItem, KeyDataPoint, ChartDataset, MarketImpactItem } from "./news-types";
import { analyzeTone, formatToneForPrompt, ToneProfile } from "./tone-analyzer";
import {
  extractClaimsFromStory,
  verifyClaims,
  scoreFactCheckResult,
  shouldRejectStory,
  logRejection,
} from "./fact-checker";
import { formatNewsForStorage, hasQualitySource } from "./news";
import { fetchContextualData, buildNewsChartData } from "./market-data";
import { runEditorialQA, logQAResult, QA_PASS_THRESHOLD } from "./editorial-qa";

let anthropic: Anthropic | null = null;
let cachedToneProfile: ToneProfile | null = null;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Photo constants — curated Unsplash queries per topic key
// ---------------------------------------------------------------------------

// Unsplash queries are tuned to return English-language, US-context imagery.
// Avoid queries that might return foreign storefront signs or unrelated retail.
const TOPIC_IMAGE_QUERIES: Record<string, string> = {
  federal_reserve: "federal reserve building washington dc architecture exterior",
  fed_macro:      "federal reserve building washington dc monetary policy exterior",
  // Inflation: CPI/BLS data context — NOT the Fed building (to avoid duplicate with federal_reserve)
  inflation:      "consumer price index inflation economic statistics bureau data",
  gdp:            "wall street new york city aerial skyline financial district",
  employment:     "american corporate office workers white collar employment hiring",
  trade_policy:   "cargo shipping containers port united states trade logistics",
  broad_market:   "new york stock exchange wall street trading floor finance",
  crypto:         "bitcoin cryptocurrency digital trading screen blockchain",
  bankruptcy:     "financial crisis corporate restructuring empty office building",
  merger_acquisition: "corporate boardroom business deal signing merger handshake",
  bond_market:    "us treasury bonds government securities fixed income finance",
  // Energy: explicitly oil infrastructure — NOT wind turbines or solar panels
  energy:         "crude oil refinery petroleum offshore drilling platform infrastructure",
  earnings:       "quarterly earnings financial results stock market data screen",
  layoffs:        "corporate downsizing workforce reduction office empty desk",
  ipo:            "stock market listing nasdaq new york exchange bell ringing",
  trade_policy_tariff: "us customs border trade tariff shipping containers port",
};

const DEFAULT_IMAGE_QUERY = "wall street financial markets stock exchange data";

/**
 * Hardcoded fallback Unsplash URLs — used when UNSPLASH_ACCESS_KEY is not set or API fails.
 *
 * EDITORIAL RULES ENFORCED HERE:
 *   1. Each topic must have a unique image URL — no two topics may share the same photo.
 *   2. Energy/oil topics must use oil infrastructure (NOT wind turbines or solar panels).
 *   3. Inflation must NOT use the same Fed building image as federal_reserve.
 *   4. All images must represent the article topic with an editorial quality score ≥ 7/10.
 *
 * Image descriptions (verified by editorial team):
 *   photo-1569025591598-35bcd6438bda — Federal Reserve building exterior, Washington DC
 *   photo-1477959858617-67f85cf4f1df — New York City skyline at night, financial district
 *   photo-1521737711867-e3b97375f902 — Office workers at corporate desks
 *   photo-1494412574643-ff11b0a5c1c3 — Cargo shipping containers at port
 *   photo-1611974789855-9c2a0a7236a3 — Stock market data trading screens
 *   photo-1518546305927-5a555bb7020d — Bitcoin coin close-up
 *   photo-1507679799987-c73779587ccf — Empty corporate office hallway
 *   photo-1521791136064-7986c2920216 — Business handshake in boardroom
 *   photo-1466611653911-95081537e5b7 — Oil platform / offshore drilling rig at sunset
 *   photo-1590283603385-17ffb3a7f29f — Financial bar chart, quarterly data
 *   photo-1486312338219-ce68d2c6f44d — Person at laptop with financial data (IPO research)
 *   photo-1604594849809-dfedff58e37f — US Treasury / government financial building
 *   photo-1556742049-0cfed4f6a45d — Business person reviewing financial documents/charts
 */
const FALLBACK_IMAGE_MAP: Record<string, string> = {
  // ── Topic-level (each must be UNIQUE — no two topics may share the same URL) ──

  // Federal Reserve / monetary policy → Fed building
  federal_reserve:
    "https://images.unsplash.com/photo-1569025591598-35bcd6438bda?w=1200&q=80",
  fed_macro:
    "https://images.unsplash.com/photo-1569025591598-35bcd6438bda?w=1200&q=80",

  // Inflation → financial data / CPI context (NOT the Fed building — avoid duplication)
  inflation:
    "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1200&q=80",

  // GDP → NYC skyline (economic output / growth context)
  gdp:
    "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1200&q=80",

  // Employment → office workers
  employment:
    "https://images.unsplash.com/photo-1521737711867-e3b97375f902?w=1200&q=80",

  // Trade policy → shipping containers at port
  trade_policy:
    "https://images.unsplash.com/photo-1494412574643-ff11b0a5c1c3?w=1200&q=80",

  // Broad market → stock exchange trading floor screens
  broad_market:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",

  // Crypto → Bitcoin coin close-up
  crypto:
    "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80",

  // Bankruptcy → empty corporate hallway
  bankruptcy:
    "https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=1200&q=80",

  // M&A → boardroom handshake
  merger_acquisition:
    "https://images.unsplash.com/photo-1521791136064-7986c2920216?w=1200&q=80",

  // Bond market → US Treasury / government finance building (unique image)
  bond_market:
    "https://images.unsplash.com/photo-1604594849809-dfedff58e37f?w=1200&q=80",

  // Energy → OIL PLATFORM / offshore drilling rig (NOT wind turbines, NOT solar panels)
  energy:
    "https://images.unsplash.com/photo-1466611653911-95081537e5b7?w=1200&q=80",

  // Earnings → financial bar chart (quarterly earnings context)
  earnings:
    "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80",

  // Layoffs → unique from bankruptcy (person reviewing documents, downsizing context)
  layoffs:
    "https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=1200&q=80",

  // IPO → unique laptop/stock listing research image
  ipo:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",

  trade_policy_tariff:
    "https://images.unsplash.com/photo-1494412574643-ff11b0a5c1c3?w=1200&q=80",

  // ── Category-level fallbacks (used when topic key has no match) ──
  // These are intentionally diverse — no category should default to the same image.

  macro:
    "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1200&q=80",   // NYC skyline
  markets:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",   // Trading screens
  policy:
    "https://images.unsplash.com/photo-1604594849809-dfedff58e37f?w=1200&q=80",   // Government finance building
  earnings_cat:
    "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80",   // Financial bar chart
  other:
    "https://images.unsplash.com/photo-1521791136064-7986c2920216?w=1200&q=80",   // Boardroom (generic business)
};

// Category-specific angles for story uniqueness
const CATEGORY_ANGLES: Record<string, string> = {
  macro: "Explore what this data point means for rate-sensitive sectors (utilities, REITs, housing), the yield curve shape, and the Fed's projected path. Cite the specific number from the source and compare it to prior period or consensus estimate.",
  earnings:
    "Focus on three things: (1) the gap between guidance and actual results, (2) the specific revenue or EPS figure versus analyst consensus, and (3) the most revealing forward-looking signal in management commentary. Don't just report the beat/miss — explain what it signals about the sector.",
  markets:
    "Identify the sector rotation or market breadth implications beneath the index-level move. Name the specific sectors gaining or losing, and explain whether this is risk-on or risk-off positioning. Use specific index or ETF performance figures.",
  policy:
    "Examine three angles: (1) who bears the regulatory or fiscal burden, (2) who benefits, and (3) what the market-pricing implication is. Include any affected companies or sectors by name. Avoid vague political editorializing.",
  crypto:
    "Anchor the story in concrete data: specific price levels, network metrics, ETF flows, or on-chain statistics. Weigh institutional adoption signals against macro headwinds. Always note the correlation (or divergence) with broader risk assets.",
  other:
    "Find the second-order market implication beyond the headline event. Ask: what does this mean for equity positioning, sector allocation, or credit spreads? Ground the analysis in a specific number from the sources.",
};

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

export function initAnthropicClient(): Anthropic {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
}

async function getToneProfile(): Promise<ToneProfile> {
  if (!cachedToneProfile) {
    cachedToneProfile = await analyzeTone();
  }
  return cachedToneProfile;
}

function extractClaudeText(response: Anthropic.Message): string {
  let text = "";
  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text + "\n";
    }
  }
  return text.trim();
}

async function callClaude(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1200
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: controller.signal as unknown as NonNullable<Parameters<typeof client.messages.create>[1]>["signal"] }
    );
    return extractClaudeText(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Structured output parser
// ---------------------------------------------------------------------------

interface ParsedArticle {
  title: string;
  story: string;
  whyThisMatters: string;
  whatToWatchNext: string;
  secondOrderImplication: string;
  keyTakeaways: string[];
  marketImpact: MarketImpactItem[];
}

/**
 * Rebuild mode — mirrors editorial-qa.ts setting.
 * Lowers confidence threshold from 0.70 to 0.58 so that Tier1 single-source
 * articles that are 12-48h old (e.g. NewsAPI delay) can pass on merit.
 */
const REBUILD_MODE = process.env.REBUILD_MODE === "true";

/**
 * Minimum editorial confidence score required to publish (0–1).
 * Production: 0.70 | Rebuild: 0.58
 *
 * Confidence breakdown:
 *   0.30  Tier 1 source present (Reuters, Bloomberg, CNBC, etc.)
 *   0.20  2+ unique sources corroborate the story (0.30 for 3+)
 *   0.20  Story is < 12h old (0.10 for 12-24h)
 *   0.20  Fact-check score ≥ 60
 *
 * Rebuild 0.58 allows: Tier1 + 1 source + 12-24h old + ok factcheck = 0.60 ≥ 0.58
 */
const CONFIDENCE_THRESHOLD = REBUILD_MODE ? 0.58 : 0.70;

/** In rebuild mode, cap published articles per run at 2 to avoid bulk-publishing weak content. */
const REBUILD_MAX_ARTICLES = 2;

/**
 * Compute a 0–1 editorial confidence score for a story group.
 * Gates: source quality, corroboration, recency, fact-check score.
 */
function computeConfidenceScore(
  group: GroupedNews,
  factCheckScore: number,
  hasTier1: boolean
): number {
  let score = 0;

  // Source quality: Tier 1 source present (0.30)
  if (hasTier1) score += 0.30;

  // Multi-source corroboration (max 0.30)
  const uniqueSourceCount = new Set(
    group.articles.map((a) => {
      const raw = a as Record<string, unknown>;
      if (typeof raw.source === "string") return raw.source as string;
      return ((raw.source as { name?: string })?.name) || "unknown";
    })
  ).size;
  if (uniqueSourceCount >= 3) score += 0.30;
  else if (uniqueSourceCount >= 2) score += 0.20;

  // Recency: use most recent article timestamp (max 0.20)
  const latestMs = group.articles.reduce((max, a) => {
    const raw = a as Record<string, unknown>;
    const ms =
      typeof raw.datetime === "number"
        ? (raw.datetime as number) * 1000
        : new Date((raw.publishedAt as string) || 0).getTime();
    return Math.max(max, ms);
  }, 0);
  const hoursOld = (Date.now() - latestMs) / (1000 * 60 * 60);
  if (hoursOld < 12) score += 0.20;
  else if (hoursOld < 24) score += 0.10;

  // Fact-check score (max 0.20)
  if (factCheckScore >= 60) score += 0.20;
  else if (factCheckScore >= 40) score += 0.10;

  return Math.round(Math.min(1.0, score) * 100) / 100;
}

/**
 * Parse the structured Claude output format into discrete fields.
 *
 * Expected format:
 *   HEADLINE: [headline]
 *   KEY_TAKEAWAYS:
 *   • [takeaway 1]
 *   • [takeaway 2]
 *   • [takeaway 3]
 *   WHY_MATTERS: [one sentence]
 *   SECOND_ORDER: [one sentence]
 *   WHAT_WATCH: [one sentence]
 *
 *   [story paragraphs]
 */
function parseStructuredOutput(raw: string, fallbackTitle: string): ParsedArticle {
  const result: ParsedArticle = {
    title: fallbackTitle,
    story: "",
    whyThisMatters: "",
    whatToWatchNext: "",
    secondOrderImplication: "",
    keyTakeaways: [],
    marketImpact: [],
  };

  const lines = raw.split("\n");
  const storyLines: string[] = [];
  let inStory = false;
  let inKeyTakeaways = false;
  let inMarketImpact = false;

  const HEADER_PREFIXES = [
    "HEADLINE:", "KEY_TAKEAWAYS:", "WHY_MATTERS:", "SECOND_ORDER:", "WHAT_WATCH:", "MARKET_IMPACT:",
  ];

  for (const line of lines) {
    const trimmed = line.trim();

    // Named section headers — always processed first
    if (trimmed.startsWith("HEADLINE:")) {
      inKeyTakeaways = false;
      result.title = trimmed.replace("HEADLINE:", "").trim();
      continue;
    }
    if (trimmed.startsWith("KEY_TAKEAWAYS:")) {
      inKeyTakeaways = true;
      // Handle inline bullet on same line: "KEY_TAKEAWAYS: • First point"
      const remainder = trimmed.replace("KEY_TAKEAWAYS:", "").trim();
      if (remainder) {
        const bullet = remainder.replace(/^[•\-\*]\s*/, "").trim();
        if (bullet) result.keyTakeaways.push(bullet);
      }
      continue;
    }
    if (trimmed.startsWith("WHY_MATTERS:")) {
      inKeyTakeaways = false;
      result.whyThisMatters = trimmed.replace("WHY_MATTERS:", "").trim();
      continue;
    }
    if (trimmed.startsWith("SECOND_ORDER:")) {
      inKeyTakeaways = false;
      result.secondOrderImplication = trimmed.replace("SECOND_ORDER:", "").trim();
      continue;
    }
    if (trimmed.startsWith("WHAT_WATCH:")) {
      inKeyTakeaways = false;
      inMarketImpact = false;
      result.whatToWatchNext = trimmed.replace("WHAT_WATCH:", "").trim();
      continue;
    }
    if (trimmed.startsWith("MARKET_IMPACT:")) {
      inKeyTakeaways = false;
      inMarketImpact = true;
      // Handle inline: "MARKET_IMPACT: OIL +4.1% up, S&P -1.2% down"
      const remainder = trimmed.replace("MARKET_IMPACT:", "").trim();
      if (remainder) {
        parseMarketImpactLine(remainder, result.marketImpact);
      }
      continue;
    }

    // Inside KEY_TAKEAWAYS block: collect bullet lines
    if (inKeyTakeaways) {
      if (trimmed === "") {
        inKeyTakeaways = false;
        continue;
      }
      if (trimmed.startsWith("•") || trimmed.startsWith("-") || trimmed.startsWith("*")) {
        const bullet = trimmed.replace(/^[•\-\*]\s*/, "").trim();
        if (bullet) result.keyTakeaways.push(bullet);
      } else {
        result.keyTakeaways.push(trimmed);
      }
      continue;
    }

    // Inside MARKET_IMPACT block: parse asset lines like "• OIL +4.1% up"
    if (inMarketImpact) {
      if (trimmed === "") {
        inMarketImpact = false;
        continue;
      }
      const bulletText = trimmed.replace(/^[•\-\*]\s*/, "").trim();
      if (bulletText) {
        parseMarketImpactLine(bulletText, result.marketImpact);
      }
      continue;
    }

    // Blank line after header block signals story start
    if (trimmed === "" && !inStory && result.title !== fallbackTitle) {
      inStory = true;
      continue;
    }

    // Story body — any non-header non-empty line
    if (trimmed.length > 0) {
      const isHeader = HEADER_PREFIXES.some((p) => trimmed.startsWith(p));
      if (!isHeader) {
        storyLines.push(trimmed);
        inStory = true;
      }
    }
  }

  result.story = storyLines.join("\n\n");

  // Fallbacks if parsing missed sections
  if (!result.title || result.title.length < 5) {
    const firstSentence = raw.split(/[.!?]/)[0].trim();
    result.title =
      firstSentence.length > 10 && firstSentence.length < 150
        ? firstSentence
        : fallbackTitle;
  }

  if (!result.story || result.story.length < 100) {
    const bodyLines = lines.filter(
      (l) =>
        !l.startsWith("HEADLINE:") &&
        !l.startsWith("KEY_TAKEAWAYS:") &&
        !l.startsWith("WHY_MATTERS:") &&
        !l.startsWith("SECOND_ORDER:") &&
        !l.startsWith("WHAT_WATCH:") &&
        !l.startsWith("MARKET_IMPACT:") &&
        !l.trim().startsWith("•")
    );
    result.story = bodyLines.join("\n").trim();
  }

  return result;
}

/**
 * Parse a MARKET_IMPACT line into a MarketImpactItem.
 * Accepts formats like:
 *   "OIL +4.1% up"
 *   "S&P 500: -1.2% down"
 *   "10Y YIELD +8bps up"
 */
function parseMarketImpactLine(text: string, out: MarketImpactItem[]): void {
  // Pattern: ASSET CHANGE direction  (e.g. "OIL +4.1% up" or "S&P 500: -1.2% down")
  const m = text.match(/^([A-Za-z0-9&. /]+?)[:]\s*([+\-]\d+[.,]?\d*\s*(?:%|bps|bp))\s*(up|down|flat)?$/i)
    ?? text.match(/^([A-Za-z0-9&. /]+?)\s+([+\-]\d+[.,]?\d*\s*(?:%|bps|bp))\s*(up|down|flat)?$/i);
  if (!m) return;

  const asset = m[1].trim().toUpperCase();
  const change = m[2].trim();
  const dirText = (m[3] ?? "").toLowerCase();
  let direction: "up" | "down" | "flat" = "flat";
  if (dirText === "up" || change.startsWith("+")) direction = "up";
  else if (dirText === "down" || change.startsWith("-")) direction = "down";

  out.push({ asset, change, direction });
}

// ---------------------------------------------------------------------------
// System Prompt — evidence-grounded journalism
// ---------------------------------------------------------------------------

function createSystemPrompt(toneProfile: ToneProfile): string {
  return `You are a financial journalist writing for Market Mountain, an independent equity research publication.

${formatToneForPrompt(toneProfile)}

Write in the style of The Wall Street Journal or Financial Times — clear, authoritative, analytical, and precise.

WORKFLOW: THESIS → EVIDENCE → NARRATIVE
Before writing, identify:
  1. THESIS: The single most important claim the sources support (one sentence)
  2. EVIDENCE: The specific numbers and facts that verify the thesis
  3. NARRATIVE: A 3-paragraph story built only from the thesis and evidence

STRUCTURE
Output your response in this exact format — no deviations:

HEADLINE: [sharp, specific news headline, 8–12 words, no dashes]
KEY_TAKEAWAYS:
• [Most important fact or number from the story]
• [Key market implication or sector impact]
• [Most important forward-looking signal to monitor]
WHY_MATTERS: [one sentence explaining why this story matters to investors]
SECOND_ORDER: [one sentence identifying the second-order market implication beyond the headline]
WHAT_WATCH: [one sentence on the most important forward-looking signal to monitor]
MARKET_IMPACT:
• [ASSET] [+/-change%] [up/down/flat] — e.g. "OIL +4.1% up" or "S&P 500 -1.2% down" or "10Y YIELD +8bps up"
• [ASSET] [+/-change%] [up/down/flat]

[blank line]
[story body — 5 sections, 500–800 words total]

STORY RULES

1 Target 500–800 words across five sections — no single section may be less than 60 words
2 Section 1 (Event Summary): Open with the single most important fact. Inverted pyramid. Most impactful number first.
3 Section 2 (Market Reaction): How markets responded in price terms. Specific index, sector, or asset moves with percentages or basis points.
4 Section 3 (Macro Analysis): Why this happened. Economic context, precedent, and the broader macro narrative.
5 Section 4 (Investor Implications): Which sectors, tickers, or strategies benefit or suffer. Name specific assets.
6 Section 5 (What to Watch Next): The most important catalyst or data point to monitor over the next 1–4 weeks.
7 Separate each section with a blank line. Do NOT label sections with headers.
8 Use specific numbers, company names, dates, and percentage figures from the sources
9 Include at least three numerical data points distributed across the story body
10 Synthesize — do not repeat the same fact in multiple sections
11 Write with analytical depth and measured tone — not sensationalism
12 Do not invent any facts not present in the provided sources or the MARKET DATA section
13 No markdown formatting — no headers, bullet points, bold, italic, or horizontal rules
14 No dashes of any kind (em dash or hyphen used as punctuation)
15 Write in third person only — never use "I" or first-person perspective
16 Write in plain prose paragraphs only
17 MARKET_IMPACT bullets: only list assets that appear in your story or MARKET DATA. Omit assets you cannot support.

FACT ACCURACY RULES (Step 11 — Data Sanity)
These rules prevent stale or fabricated numbers:
- If you cite the Fed Funds Rate, it must match the MARKET DATA section or omit entirely
- If you cite a Treasury yield, it must match or be qualified as "approximately"
- If you cite CPI, use the most recent figure from the MARKET DATA section
- Do not cite market data values that contradict the MARKET DATA section provided
- If the sources and MARKET DATA conflict, prefer MARKET DATA for quantitative claims
- Remove or soften any unverifiable numeric claim — write "around", "approximately", or omit

SOURCE CONFLICT RESOLUTION (Step 12a)
When two sources report different numbers for the same metric:
- Prefer the higher-quality source: Reuters > Bloomberg > WSJ > CNBC > Tier 2
- If sources conflict with MARKET DATA, always prefer MARKET DATA for quantitative claims
- When you cannot resolve a conflict, omit the disputed figure or qualify it: "reports varied on the exact figure"
- Do not average conflicting numbers or invent a middle ground

SOURCE ATTRIBUTION (Step 12b)
Where data points are used from MARKET DATA, attribute them. Examples:
  "CPI rose 2.4% year over year in February, according to the Bureau of Labor Statistics."
  "The 10-year Treasury yield stood near 4.28%, per Treasury data."
  "WTI crude rose above $92, according to EIA spot price data."

CONTENT QUALITY (Step 13)
Avoid:
- Sensational or alarmist language ("collapse", "catastrophe", "unprecedented" unless quoting)
- Speculation presented as fact
- Unsupported geopolitical predictions
- Forward guidance stated as certainty
Prefer:
- Neutral tone: "analysts expect", "markets are pricing in", "data suggest"
- Evidence-based conclusions tied to cited data
- Concise financial journalism style (no padding, no throat-clearing)

EDITORIAL LANGUAGE STANDARDS (Step 14)
Probabilistic language: Use hedged language for forward-looking claims. Write "may", "could",
"suggests", "appears to", or "data indicate" rather than stating conclusions as certain fact.

Banned phrases — never use these exact expressions:
- "structural shift" (use "longer-term change" or describe specifically)
- "parabolic adoption" (use actual growth figures instead)
- "macro headwinds testing conviction"
- "creates opportunity" (state the specific catalyst)
- "unprecedented" (unless directly quoting a source)
- "game-changer" or "paradigm shift"

Geopolitical restraint: For international tensions and conflict, prefer measured language.
- Use "tensions", "concerns", "friction", "trade dispute" where accurate
- Avoid "war", "escalation", "crisis" unless directly quoting officials or reporting established facts
- Do not editorialize on geopolitical outcomes — state what happened, not what it means politically

ANALYTICAL DEPTH RULE (Step 15)
Every story must contain:
- At least one specific percentage, dollar figure, or basis-point figure
- A named sector or asset class that is affected (not just "markets")
- A comparison to prior period, consensus, or historical context
- A forward-looking signal grounded in the data (not speculation)

If the sources do not support all four requirements, scale back the claims — do not invent data.

EDITORIAL SELF-CRITIQUE (Step 16)
Before delivering your final output, perform an internal editorial review. Ask:
"If I were a senior macro editor at the Financial Times, would I stake my reputation on publishing this?"

Review checklist:
□ Is the thesis sharp and non-obvious — not just restating the headline?
□ Does every sentence earn its place — could any be deleted without loss?
□ Are all numeric claims traceable to a SOURCE or MARKET DATA entry above?
□ Is the forward-looking signal specific and actionable — not just "watch for volatility"?
□ Is this story meaningfully different from generic macro uncertainty coverage?
□ For earnings stories: is the sector or index read-through clearly stated?

Strengthen any weak section before delivering. If sources are too thin to support the thesis, scale back claims — do not pad with qualifiers instead of facts.

SENTENCE CLARITY AND FLOW (Step 16a)
Write in clear, tight sentences. Each sentence should carry one primary idea.
- Break sentences that stack multiple subordinate clauses using "as", "while", or "and" into two separate sentences
- Target 20–30 words per sentence for financial news writing
- Long explanations should be distributed across 2–3 sentences, not compressed into one
- When two closely related analytical clauses follow naturally from each other, prefer a semicolon over a full stop to preserve flow. Example: "This is not merely a commodity price event; it represents a repricing of inflation expectations" rather than two short fragments.
- Avoid orphaned one-sentence paragraphs that could read as conclusions detached from their context

ANALYTICAL CALIBRATION (Step 16b)
Use precise but measured language. Avoid overstating the magnitude or uniqueness of events.
- Prefer "one of the more significant" over "the largest" or "the most severe" unless the source explicitly makes that claim
- Prefer "may compress multiples" and "could weigh on valuations" over "will compress" or "will force"
- Prefer "markets appear to be pricing in" over definitive statements about future market behavior
- For assets with mixed behavior during geopolitical events (e.g., gold, currencies): note that responses can vary depending on whether markets are pricing currency risk or real rate risk — do not assert a single predictable direction unless the source data clearly supports it

MACRO MECHANISM CLARITY (Step 16c)
For stories about oil shocks, inflation, or rate expectations, make the causal chain explicit and concise:
1. Higher energy or commodity prices → consumer costs and producer input costs rise
2. Higher costs → upward pressure on CPI and PCE measures the Fed monitors
3. Higher inflation expectations → markets price in a longer restrictive policy period
4. Longer rate expectations → higher discount rates compress equity valuations
5. Compression is most acute in longer-duration assets: growth stocks, REITs, utilities

Name the specific sectors affected. Do not write "equity markets fell" without identifying which sectors and why.

For yield/rates stories: state whether the rate move reflects stronger growth expectations, higher inflation pricing, or direct Fed guidance changes — the cause matters for sector implications.

TOPIC-SPECIFIC PRECISION (Step 16d)
California refining: When relevant to an energy story, note that California operates an isolated refining system with limited pipeline connections to other U.S. regions. This makes the state especially sensitive to supply shocks in Pacific Basin or Gulf crude, causing price disruptions to transmit to pump prices faster than in most other regions.

Gold in geopolitical events: Gold's response to geopolitical shocks is mixed and depends on the nature of the shock. It may rise on safe-haven demand or fall if the event raises real interest rate expectations. Do not assert a single predictable direction for gold during geopolitical events unless clearly supported by the source data.

HEADLINE STANDARD (Step 16e)
Headlines must be 8–12 words, analytically specific, and publication-quality.
- Use a strong active verb that reflects the causal relationship
- Name the key metric or event (specific price level, policy action, data print)
- Avoid weak verbs: "tests", "weighs on", "highlights", "pushes" — prefer "presses", "forces", "drives", "lifts", "cuts"
- Target Financial Times or Bloomberg Markets front-page quality

Strong: "Iran Conflict Pushes Oil Above $100, Pressuring Equities and Rate Expectations"
Weak: "Iran conflict pushes oil past $100, testing equity valuations and rate expectations"

GEOPOLITICAL LANGUAGE STANDARD (Step 16f)
Market Mountain is macro commentary, not a newswire. When writing about geopolitical events:

DO NOT make definitive claims about specific military actions, attacks, or confirmed incidents unless they are directly quoted from a named, credible source in the article.
- BAD: "Iran launched tanker attacks in the Persian Gulf"
- BAD: "China fired missiles across the Taiwan Strait"
- GOOD: "escalating tensions involving Iran and shipping risks in the Persian Gulf"
- GOOD: "rising geopolitical uncertainty in the region"
- GOOD: "regional supply risk following reports of increased military activity"

Frame geopolitical developments as market risks, not confirmed facts:
- Use: "tensions", "uncertainty", "risk", "conflict", "disruption", "pressure"
- Avoid: "attacks", "strikes", "invasions", "launched", "seized" — unless directly sourced with a named outlet

The article should explain the MARKET IMPLICATION of geopolitical risk, not report the geopolitical event as a journalist would. Focus on:
- How the risk is priced into assets (oil, gold, yields, dollar, equities)
- The transmission mechanism (supply disruption → inflation → rate expectations → equity multiples)
- What investors are monitoring, not what governments are doing

When uncertain whether an event is confirmed, use: "amid reports of", "following elevated tensions", "as regional risk indicators rose".

CHART ANCHOR RULE (Step 17)
For inflation, energy, labor, rates, GDP, and earnings topics:
Write one sentence in the analysis paragraph that explicitly references the trend data and sets up the visual context.
Anchor it with a specific figure from the MARKET DATA section above.
Example:
"WTI crude averaged above $85 per barrel over the past year, sustaining cost pressure on transportation-dependent sectors."
This sentence must cite a specific number — not a vague directional description.

LEDE RULE: The opening sentence must NOT begin with the company or topic name as the grammatical subject.
Lead with the key number, consequence, or market implication instead.

BANNED LEDES:
"The Federal Reserve on Wednesday..."
"Apple Inc. reported..."
"Bitcoin rose..."

GOOD LEDES:
"A quarter-point rate hold and a cautious forward outlook sent Treasury yields lower on Wednesday."
"Record services revenue of $23.1 billion masked a steeper-than-expected decline in iPhone unit sales."
"Institutional inflows of $1.2 billion in a single session lifted Bitcoin past $70,000 for the first time since 2021."

Write for a financially literate reader who values accuracy, analysis, and forward-looking insight over hype.

CHART CAPTION STANDARD (Step 18a)
When a chart is present in the article, ensure the narrative paragraph preceding it contains a direct anchor sentence that sets up the chart. The anchor must:
- Reference the specific metric shown in the chart (e.g., "WTI crude", "10-year yield")
- Include a specific number from the data (e.g., "$101 per barrel", "4.71%")
- Connect the data to its macro implication in one sentence
- Read as natural prose — not as a caption label

Caption tone: Bloomberg Markets style. Concise, analytical, no filler. Each caption should state (1) what the chart shows, (2) why the current level matters, (3) the macro implication for investors. Maximum 2 sentences.

CHART DATA INTEGRITY (Step 18c)
Every chart must pass this internal consistency check before inclusion:

1. SERIES IDENTITY — Title, source, caption, and plotted values must all refer to the exact same instrument.
   - BAD: Title = "U.S. Dollar Index (DXY)", Source = "FRED DTWEXBGS", Values = 120–127
   - GOOD: Title = "Nominal Broad U.S. Dollar Index", Source = "FRED — DTWEXBGS", Values = 115–130
   - GOOD: Title = "U.S. Dollar Index (DXY)", Source = "ICE / Bloomberg", Values = 95–115

2. DXY vs FRED BROAD DOLLAR — These are two distinct instruments. Never mix them:
   - ICE DXY (6-currency basket): Typical level 95–115. Cite as: "ICE / Bloomberg — DXY"
   - FRED DTWEXBGS (Nominal Broad Index): Typical level 115–135. Cite as: "FRED — DTWEXBGS"
   - Do not use "DXY" in a caption or title if the data source is DTWEXBGS, and vice versa.

3. SPOT vs MONTHLY AVERAGE — If the endpoint is a current spot price and the historical series is monthly averages, the caption must note this. Example: "Latest: $98.70 spot (Mar 13, 2026); historical bars = monthly average."

4. ENDPOINT ACCURACY — The final data point should reflect actual recent market data, not an invented or forward-projected value. If the endpoint is narrative (e.g., an anticipated move), the caption must say "projected" or "as of [date]."

5. SOURCE FORMAT:
   - FRED series: "FRED — [Series Name] ([Ticker])" e.g., "FRED — GS10 (Monthly Average)" or "EIA — WTI Cushing Spot (MCOILWTICO)"
   - ICE DXY: "ICE / Bloomberg — U.S. Dollar Index (DXY)"
   - EIA oil: "EIA — WTI Cushing Spot Price (MCOILWTICO)"

6. GEOPOLITICAL CAUSAL LANGUAGE IN CAPTIONS — Apply Step 16f here too. Prefer "amid escalating tensions" over "on Iran tanker attacks."

7. TEXT/CHART CONSISTENCY — The article body, headline, and key takeaways must agree with the chart endpoint value. This is mandatory:
   - If the chart endpoint shows $98.7, do NOT write "crossed $100" in the text. Write "surged toward $100" or "approached $100."
   - If the chart endpoint shows 4.28%, do NOT write "yields surged to 4.71%" in the text.
   - If the chart shows the dollar at 100.5, do NOT write "dollar index above 107" in the text.
   - The chart is the authoritative data source. The prose must match it, not override it.
   - Headlines must also agree: "Pushes Oil Toward $100" not "Pushes Oil Above $100" if the chart endpoint is below $100.
   - When in doubt, hedge with language like "toward", "near", "approaching", "surged to" rather than claiming a specific level the data does not confirm.

TAG STANDARD (Step 18b)
Article tags must come exclusively from this controlled taxonomy:
ENERGY · MACRO · RATES · EQUITIES · USD · GEOPOLITICS · COMMODITIES · TECH · FINANCIALS · AI · CRYPTO

Additionally, specific well-known asset identifiers are allowed: WTI · CRUDE · GOLD · SPX · DXY · BTC · ETH · VIX

Rules:
- Include 2–3 tags maximum
- Tags must be complete words — never truncated or partially matched
- ENERGY is preferred over COMMODITIES for oil/gas stories
- Do not invent new tags outside this list`;
}

// ---------------------------------------------------------------------------
// User Prompt — includes evidence packet
// ---------------------------------------------------------------------------

function createUserPrompt(
  group: GroupedNews,
  formattedArticles: ReturnType<typeof formatNewsForStorage>,
  contextualData: KeyDataPoint[]
): string {
  const articleTexts = formattedArticles
    .map(
      (article, i) =>
        `SOURCE ${i + 1}
Title: ${article.title}
Summary: ${article.summary}
Published: ${article.publishedAt}
From: ${article.source}`
    )
    .join("\n\n");

  const angle = CATEGORY_ANGLES[group.category] ?? CATEGORY_ANGLES.other;

  const dataContext =
    contextualData.length > 0
      ? `\nMARKET DATA (verified primary-source figures — use these in your analysis paragraph and attribute them):\n` +
        contextualData
          .map((d) => `  • ${d.label}: ${d.value}${d.change ? ` (${d.change})` : ""}${d.source ? ` [Source: ${d.source}]` : ""}`)
          .join("\n") +
        `\n\nCLAIM-TO-SOURCE RULE: Every numeric claim in your story must map to either a SOURCE above or a MARKET DATA bullet above. If you cannot trace a number to one of these, omit it or rewrite it as qualitative analysis.`
      : "";

  return `Write one cohesive financial news story about "${group.topic}"

SOURCES (synthesize all — do not simply summarize one):
${articleTexts}
${dataContext}

Editorial angle: ${angle}

Output HEADLINE, KEY_TAKEAWAYS (3 bullets), WHY_MATTERS, SECOND_ORDER, WHAT_WATCH, MARKET_IMPACT (1–3 asset bullets) first, then one blank line, then the 5-section story (500–800 words). Do NOT label the sections with headers.`;
}

// ---------------------------------------------------------------------------
// Pre-synthesis story worthiness gate
// ---------------------------------------------------------------------------

/** Topics that map to known market-impacting categories. */
const SYNTHESIS_MARKET_TOPICS = new Set([
  "federal_reserve", "fed_macro", "inflation", "gdp", "employment",
  "bond_market", "trade_policy", "trade_policy_tariff", "broad_market",
  "markets", "crypto", "energy", "earnings", "merger_acquisition",
  "bankruptcy", "ipo", "layoffs", "commodities", "currency",
]);

/** Earnings signals that allow a company-specific story past the market-impact test. */
const EARNINGS_WORTHINESS_PATTERNS: RegExp[] = [
  /\b(beat|miss|exceed|surpass|disappoint)\b/i,
  /\bguidance\b/i,
  /\b(eps|earnings per share|revenue|profit|margin)\b/i,
  /\b(nvidia|apple|microsoft|meta|alphabet|google|amazon|jpmorgan|tesla|goldman|berkshire|netflix|salesforce|broadcom|tsm|tsmc)\b/i,
  /\b(semiconductor|artificial intelligence|consumer demand|banking|energy sector)\b/i,
];

/** Catalyst keywords that indicate a concrete market driver exists. */
const CATALYST_KEYWORDS =
  /\bcut|hike|miss|beat|shock|surge|crash|guidance|regulation|data|report|OPEC|Fed|CPI|NFP|jobs|earnings|tariff|sanction|default|bankruptcy|rate\b/i;

/** Speculative language patterns — stories that are all opinion with no data. */
const SPECULATIVE_PATTERNS: RegExp[] = [
  /\bmight\b|\bcould\b|\bwould\b/,
  /\banalysts?\s+(say|predict|expect|believe)\b/i,
  /\bexperts?\s+(say|predict|warn)\b/i,
  /\buncert(ain|y)\b/i,
  /\bquestion[s]?\b/i,
];

/**
 * Pre-synthesis story worthiness gate.
 * Called BEFORE invoking Claude — rejects groups that would produce weak articles
 * and saves Anthropic API credits.
 *
 * Tests (in order):
 *   1. Market Impact   — topic maps to a known market category
 *   2. Move Threshold  — small moves require a major catalyst
 *   3. Catalyst Clarity — must have concrete data, not pure speculation
 *   4. News Significance — importance floor
 */
function checkStoryWorthiness(
  group: GroupedNews
): { worthy: boolean; reason: string } {
  const allTitles = group.articles
    .map((a) => {
      const raw = a as Record<string, unknown>;
      return String(raw.title ?? raw.headline ?? "").toLowerCase();
    })
    .join(" ");

  // ── Test 1: Market Impact ─────────────────────────────────────────────────
  const topicInSet = SYNTHESIS_MARKET_TOPICS.has(group.topic);

  // Earnings lane: company-specific story allowed if ≥2 earnings signals present
  const isEarningsLane =
    group.topic === "earnings" &&
    EARNINGS_WORTHINESS_PATTERNS.filter((p) => p.test(allTitles)).length >= 2;

  if (!topicInSet && !isEarningsLane && group.importance < 9) {
    return {
      worthy: false,
      reason: `topic "${group.topic}" does not map to a market-impacting category (importance=${group.importance})`,
    };
  }

  // ── Test 2: Market Move Threshold Filter ─────────────────────────────────
  // Detect small percentage moves (0.1–0.29%) or tiny bps moves (1–5 bps)
  const hasSmallMove =
    /\b0\.[0-2]\d*\s*%/.test(allTitles) ||
    /\b[1-5]\s*(bps|basis points)\b/i.test(allTitles);
  const hasCatalyst = CATALYST_KEYWORDS.test(allTitles);

  if (hasSmallMove && !hasCatalyst) {
    return {
      worthy: false,
      reason: "low-signal market move with no identifiable catalyst — too incremental to publish",
    };
  }

  // ── Test 3: Catalyst Clarity ──────────────────────────────────────────────
  // Require at least one concrete market signal (number, move, event verb)
  const hasConcreteSignal =
    /\d+%|\d+\.\d+|rose|fell|gained|dropped|surged|tumbled|cut|raised|hiked|missed|beat/i.test(
      allTitles
    );

  const speculativeCount = SPECULATIVE_PATTERNS.filter((p) =>
    p.test(allTitles)
  ).length;

  if (!hasConcreteSignal && speculativeCount >= 3) {
    return {
      worthy: false,
      reason: "all source titles are speculative opinion with no concrete event or market data",
    };
  }

  // ── Test 4: News Significance ─────────────────────────────────────────────
  const WORTHINESS_IMPORTANCE_FLOOR = 7;
  if (group.importance < WORTHINESS_IMPORTANCE_FLOOR) {
    return {
      worthy: false,
      reason: `importance score ${group.importance} below worthiness threshold ${WORTHINESS_IMPORTANCE_FLOOR}`,
    };
  }

  return { worthy: true, reason: "passes all story worthiness tests" };
}

// ---------------------------------------------------------------------------
// MAIN SYNTHESIS FUNCTION
// ---------------------------------------------------------------------------

export async function synthesizeGroupedArticles(
  groupedNews: GroupedNews[],
  existingArticles: NewsItem[] = []
): Promise<{
  stories: NewsItem[];
  stats: { posted: number; rejected: number; errors: number; preRejected: number };
}> {
  const stories: NewsItem[] = [];
  const stats = { posted: 0, rejected: 0, errors: 0, preRejected: 0 };

  const toneProfile = await getToneProfile();
  const client = initAnthropicClient();

  // Per-run image cache — avoid duplicate Unsplash API calls for same topic
  const runImageCache = new Map<string, string>();

  // Track chart budget — raised to 4 (editorial policy: data stories should have charts)
  let chartCount = 0;
  const MAX_CHARTS_PER_RUN = 4;

  // ── Cross-feed image deduplication ─────────────────────────────────────────
  // Collect all image URLs already in the feed (existing articles + current run).
  // Prevents two articles from sharing the same hero image.
  // The set grows as new stories are synthesized within this run.
  const usedImageBaseUrls = new Set<string>(
    existingArticles
      .filter((a) => a.imageUrl)
      .map((a) => a.imageUrl!.split("?")[0])
  );

  // In-run topic dedup — skip groups whose topic is too similar to one already queued
  const seenTopics = new Set<string>();
  const groupsToProcess = groupedNews.filter((group) => {
    const key = group.topic.toLowerCase().replace(/[_\s]+/g, "_");
    for (const seen of seenTopics) {
      if (key === seen || key.startsWith(seen) || seen.startsWith(key)) return false;
    }
    seenTopics.add(key);
    return true;
  });

  if (REBUILD_MODE) {
    console.log(
      `[synthesis] REBUILD MODE: confidence threshold=${CONFIDENCE_THRESHOLD}, ` +
      `article cap=${REBUILD_MAX_ARTICLES}, processing ${groupsToProcess.length} groups`
    );
  }

  for (const group of groupsToProcess) {
    // Rebuild mode: stop once article cap is reached
    if (REBUILD_MODE && stats.posted >= REBUILD_MAX_ARTICLES) {
      console.log(`[synthesis] REBUILD MODE: article cap (${REBUILD_MAX_ARTICLES}) reached — stopping synthesis early`);
      break;
    }

    try {
      // ── Pre-synthesis story worthiness gate (hard stop) ───────────────────
      // Reject unworthy groups BEFORE calling Claude to save API credits.
      const worthiness = checkStoryWorthiness(group);
      if (!worthiness.worthy) {
        stats.preRejected++;
        console.warn(
          `[synthesis] Pre-synthesis reject "${group.topic}": ${worthiness.reason}`
        );
        continue;
      }

      const formattedArticles = formatNewsForStorage(group.articles);

      console.log(
        `[synthesis] Processing: "${group.topic}" (${group.articles.length} sources, importance=${group.importance})`
      );

      // Fetch contextual market data for evidence enrichment
      let contextualData: KeyDataPoint[] = [];
      try {
        contextualData = await fetchContextualData(group.topic);
        if (contextualData.length > 0) {
          console.log(`[synthesis] Enriched "${group.topic}" with ${contextualData.length} market data points`);
        }
      } catch {
        // Market data failure never blocks synthesis
      }

      const systemPrompt = createSystemPrompt(toneProfile);
      const userPrompt = createUserPrompt(group, formattedArticles, contextualData);

      const synthesizedText = await callClaude(client, systemPrompt, userPrompt, 2400);

      if (!synthesizedText || synthesizedText.length < 200) {
        stats.errors++;
        console.error(
          `[synthesis] Output too short for "${group.topic}" — length: ${synthesizedText?.length ?? 0}`
        );
        continue;
      }

      console.log(`[synthesis] Generated ${synthesizedText.length} chars for "${group.topic}"`);

      // Fact-check — extract claims, verify, score, and log results
      const claims = extractClaimsFromStory(synthesizedText);
      const { results: factCheckResults, overallScore } = await verifyClaims(claims);
      const adjustedScore = scoreFactCheckResult(factCheckResults); // Uses actual results (not empty array)

      // Log claim-to-source mapping for transparency (Step 14)
      if (factCheckResults.length > 0) {
        console.log(`[synthesis] Fact-check for "${group.topic}": score=${overallScore} (adjusted=${adjustedScore})`);
        for (const r of factCheckResults) {
          const status = r.verified ? "✓" : "✗";
          const src = r.sources && r.sources.length > 0 ? ` [${r.sources[0]}]` : "";
          console.log(`  ${status} "${r.claim.substring(0, 60)}..." — confidence=${r.confidence}${src}`);
        }
      }

      // Reject if adjusted score too low — threshold=55 blocks low-confidence outputs
      // while allowing well-formed financial journalism through
      const FACT_CHECK_THRESHOLD = 55;
      if (shouldRejectStory(adjustedScore, FACT_CHECK_THRESHOLD)) {
        stats.rejected++;
        console.warn(`[synthesis] Rejected "${group.topic}" — fact-check score ${adjustedScore} < ${FACT_CHECK_THRESHOLD}`);
        logRejection(group.topic, `Fact check score: ${adjustedScore}`, adjustedScore);
        continue;
      }

      // Confidence score — composite quality gate (source tier + corroboration + recency + fact-check)
      const groupHasTier1 = hasQualitySource(group.articles);
      const confidenceScore = computeConfidenceScore(group, overallScore, groupHasTier1);
      if (confidenceScore < CONFIDENCE_THRESHOLD) {
        stats.rejected++;
        console.warn(
          `[synthesis] Rejected "${group.topic}" — confidence ${confidenceScore} < ${CONFIDENCE_THRESHOLD} ` +
          `(tier1=${groupHasTier1}, sources=${group.articles.length}, factCheck=${overallScore})`
        );
        logRejection(group.topic, `Confidence score: ${confidenceScore}`, adjustedScore);
        continue;
      }
      console.log(`[synthesis] Confidence check passed: "${group.topic}" — score=${confidenceScore}`);

      // Parse structured output
      const parsed = parseStructuredOutput(synthesizedText, group.topic);

      // Validate required fields
      if (!parsed.title || parsed.title.length < 5) {
        stats.errors++;
        console.error(`[synthesis] Failed to parse headline for "${group.topic}"`);
        continue;
      }

      if (!parsed.story || parsed.story.length < 100) {
        stats.errors++;
        console.error(`[synthesis] Story body too short for "${group.topic}"`);
        continue;
      }

      // ── Image resolution (Editorial Match Rule) ───────────────────────────
      // Step 1: Detect if the article is specifically about oil/energy
      //   regardless of how it was categorized (e.g., oil surge → broad_market).
      //   Oil stories must use oil infrastructure imagery, never generic NYSE or
      //   renewable energy visuals (wind turbines, solar panels).
      const articleTitles = group.articles.map((a) => {
        const raw = a as Record<string, unknown>;
        return String(raw.title ?? raw.headline ?? "");
      }).join(" ");
      const isOilStory =
        group.topic !== "energy" &&
        /\boil\b|crude\b|WTI\b|brent\b|OPEC\b|petroleum\b|refiner/i.test(
          group.topic + " " + articleTitles
        );

      // Step 2: Pick Unsplash query — override with energy for mis-categorized oil stories
      const imageTopicOverride = isOilStory ? "energy" : group.topic;
      let unsplashUrl = await fetchUnsplashImage(imageTopicOverride, runImageCache);

      // Step 3: If Unsplash result is already in the feed, fetch a different image
      //   using the fallback map or try a slightly different query on retry.
      if (unsplashUrl) {
        const base = unsplashUrl.split("?")[0];
        if (usedImageBaseUrls.has(base)) {
          console.log(`[synthesis] Image dedup: Unsplash result for "${imageTopicOverride}" already used — trying fallback`);
          unsplashUrl = null; // Force fallback
        }
      }

      // Step 4: Fallback chain — topic fallback → category fallback → undefined
      //   Skip any fallback URL that's already in use.
      const candidateFallbacks = [
        FALLBACK_IMAGE_MAP[imageTopicOverride],
        FALLBACK_IMAGE_MAP[group.topic],
        FALLBACK_IMAGE_MAP[group.category],
      ].filter(Boolean) as string[];

      const availableFallback = candidateFallbacks.find(
        (url) => !usedImageBaseUrls.has(url.split("?")[0])
      );

      const imageUrl = unsplashUrl ?? availableFallback ?? undefined;

      // Register chosen image URL so subsequent stories in this run won't reuse it
      if (imageUrl) {
        usedImageBaseUrls.add(imageUrl.split("?")[0]);
      }

      // Optional chart data — only for macro/FRED-backed topics, capped at MAX_CHARTS_PER_RUN
      // Energy + rates stories get a secondary chart (WTI → 10Y yield companion, etc.)
      let chartData: ChartDataset[] | undefined;
      if (chartCount < MAX_CHARTS_PER_RUN) {
        const primary = await buildChartData(group.topic);
        if (primary) {
          chartCount++;
          chartData = [primary];

          // Companion chart routing — topic-aware secondary/tertiary charts
          const topicNorm = group.topic.toLowerCase().replace(/\s+/g, "_");

          // Secondary chart: rates companion for energy, equities companion for rates/fed
          const secondaryTopic =
            topicNorm === "energy" || topicNorm === "trade_policy" ? "bond_market" :
            topicNorm === "bond_market" || topicNorm === "federal_reserve" || topicNorm === "fed_macro" ? "broad_market" :
            null;

          if (secondaryTopic && chartCount < MAX_CHARTS_PER_RUN) {
            const secondary = await buildChartData(secondaryTopic);
            if (secondary) {
              const primaryPos = primary.insertAfterParagraph ?? 0;
              secondary.insertAfterParagraph = Math.max(primaryPos + 2, 2);
              if (!secondary.chartLabel) secondary.chartLabel = "MARKET CONTEXT";
              chartCount++;
              chartData.push(secondary);
            }
          }

          // Optional tertiary DXY chart: add when article explicitly references dollar strength/weakness
          // Applies to energy, macro, trade, and policy stories that discuss USD
          const dollarMentions = (synthesizedText.match(/\b(dollar|USD|DXY|greenback|dollar\s+index|currency)\b/gi) ?? []).length;
          const topicSupportsDxy = ["energy", "trade_policy", "trade_policy_tariff", "inflation", "federal_reserve", "fed_macro"].includes(topicNorm);
          if (dollarMentions >= 2 && topicSupportsDxy && chartCount < MAX_CHARTS_PER_RUN) {
            const dxy = await buildChartData("dxy");
            if (dxy) {
              // Place DXY chart after the last secondary chart
              const lastPos = chartData[chartData.length - 1]?.insertAfterParagraph ?? 2;
              dxy.insertAfterParagraph = Math.min(lastPos + 2, 4);
              if (!dxy.chartLabel) dxy.chartLabel = "CURRENCY";
              chartCount++;
              chartData.push(dxy);
            }
          }
        }
      }

      const newsItem: NewsItem = {
        id: generateId(group.topic),
        title: parsed.title,
        story: parsed.story,
        category: group.category,
        topicKey: group.topic,
        imageUrl,
        publishedAt: new Date().toISOString(),
        importance: group.importance,
        sentiment: inferSentiment(synthesizedText),
        relatedTickers: generateTags(group.topic, synthesizedText, group.category),
        sourcesUsed: group.articles.map((article) => {
          const fmt = formatNewsForStorage([article])[0];
          return { title: fmt.title, url: fmt.url, source: fmt.source };
        }),
        factCheckScore: overallScore,
        verifiedClaims: claims.slice(0, 3),
        // Editorial enrichment
        whyThisMatters: parsed.whyThisMatters || undefined,
        whatToWatchNext: parsed.whatToWatchNext || undefined,
        secondOrderImplication: parsed.secondOrderImplication || undefined,
        keyDataPoints: contextualData.length > 0 ? contextualData : undefined,
        chartData,
        keyTakeaways: parsed.keyTakeaways.length > 0 ? parsed.keyTakeaways : undefined,
        confidenceScore,
        // Event-first architecture
        marketImpact: parsed.marketImpact.length > 0 ? parsed.marketImpact : undefined,
        wordCount: parsed.story.trim().split(/\s+/).length,
      };

      // ── Editorial Quality Gate ────────────────────────────────────────────
      // Score the article 0–100. Reject if score < QA_PASS_THRESHOLD (85).
      // The QA gate checks: confidence, fact-check, source quality, title
      // quality, thesis clarity (4 questions), image uniqueness, and story
      // completeness. Articles that pass all existing synthesis gates but are
      // low-quality (thin thesis, poor title, duplicate image) are blocked here.
      const qaResult = runEditorialQA(newsItem, [...existingArticles, ...stories]);
      logQAResult(group.topic, qaResult);

      if (!qaResult.passed) {
        stats.rejected++;
        console.warn(
          `[synthesis] QA gate rejected "${parsed.title}" — score=${qaResult.score}/${QA_PASS_THRESHOLD} minimum`
        );
        // Return the image URL to the available pool since we're not publishing
        if (imageUrl) usedImageBaseUrls.delete(imageUrl.split("?")[0]);
        continue;
      }

      stories.push(newsItem);
      stats.posted++;

      console.log(
        `[synthesis] ✓ "${parsed.title}" — qa=${qaResult.score}/100, words=${newsItem.wordCount}, ` +
        `takeaways=${parsed.keyTakeaways.length}, whyMatters=${!!parsed.whyThisMatters}, ` +
        `keyData=${contextualData.length}, chart=${!!chartData}, marketImpact=${parsed.marketImpact.length}, ` +
        `confidence=${confidenceScore}`
      );

      await sleep(2000);
    } catch (error) {
      stats.errors++;
      console.error(
        `[synthesis] Exception on "${group.topic}":`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const mode = REBUILD_MODE ? "REBUILD" : "PRODUCTION";
  console.log(
    `[synthesis] Done [${mode}]: processed=${groupsToProcess.length}, ` +
    `preRejected=${stats.preRejected}, posted=${stats.posted}, rejected=${stats.rejected}, errors=${stats.errors} | ` +
    `confidence_threshold=${CONFIDENCE_THRESHOLD}${REBUILD_MODE ? `, cap=${REBUILD_MAX_ARTICLES}` : ""}`
  );

  if (stats.posted === 0) {
    console.warn(
      `[synthesis] ZERO stories published. Possible causes:\n` +
      `  1. Chart hard-fail: FRED_API_KEY/BLS_API_KEY/EIA_API_KEY missing → topics requiring charts score 0/10\n` +
      `  2. Confidence < ${CONFIDENCE_THRESHOLD}: Check Tier1 source presence + multi-source corroboration\n` +
      `  3. QA score < ${REBUILD_MODE ? 78 : 85}/100: Review [editorial-qa] logs above for per-test scores\n` +
      `  4. Source tier mismatch: MarketWatch/Barron's/Economist now fixed in editorial-qa.ts\n` +
      `  Set REBUILD_MODE=true in Vercel env to temporarily lower thresholds for feed bootstrapping.`
    );
  }

  return { stories, stats };
}

// ---------------------------------------------------------------------------
// Chart builder — delegates to market-data.ts (FRED / BLS / EIA routing)
// ---------------------------------------------------------------------------

/**
 * Resolve chart data for a topic. Delegates to buildNewsChartData() in
 * market-data.ts, which routes each topic to the best available source
 * (EIA for energy, BLS for labor/inflation, FRED for macro/bond).
 * Returns undefined if no API key is set or the topic has no chart mapping.
 */
async function buildChartData(topicKey: string): Promise<ChartDataset | undefined> {
  return buildNewsChartData(topicKey);
}

// ---------------------------------------------------------------------------
// Unsplash image fetcher (three-tier)
// ---------------------------------------------------------------------------

async function fetchUnsplashImage(
  topicKey: string,
  cache: Map<string, string>
): Promise<string | null> {
  const apiKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!apiKey) return null;

  const cached = cache.get(topicKey);
  if (cached) return cached;

  const query = TOPIC_IMAGE_QUERIES[topicKey] ?? DEFAULT_IMAGE_QUERY;

  try {
    const url =
      `https://api.unsplash.com/search/photos` +
      `?query=${encodeURIComponent(query)}` +
      `&per_page=5` +
      `&orientation=landscape` +
      `&content_filter=high`;

    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${apiKey}` },
    });

    if (!res.ok) return null;

    const data = await res.json() as { results?: Array<{ urls?: { regular?: string } }> };
    const photoUrl = data.results?.[0]?.urls?.regular ?? null;
    if (!photoUrl) return null;

    const base = photoUrl.split("?")[0];
    const normalized = `${base}?w=1200&q=80`;
    cache.set(topicKey, normalized);
    return normalized;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferSentiment(text: string): "positive" | "negative" | "neutral" {
  const lower = text.toLowerCase();
  const positive = ["growth", "gain", "rise", "strength", "rally", "beat", "surpass", "record"];
  const negative = ["fall", "decline", "loss", "risk", "weakness", "miss", "contraction", "recession"];
  const pos = positive.filter((w) => lower.includes(w)).length;
  const neg = negative.filter((w) => lower.includes(w)).length;
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Controlled tag taxonomy — prevents malformed/truncated tags forever
// ---------------------------------------------------------------------------

/** Complete list of allowed taxonomy tags */
const ALLOWED_TAGS = new Set([
  "ENERGY", "MACRO", "RATES", "EQUITIES", "USD",
  "GEOPOLITICS", "COMMODITIES", "TECH", "FINANCIALS", "AI", "CRYPTO",
  // Asset-level identifiers (well-known, unambiguous)
  "WTI", "CRUDE", "GOLD", "SPX", "DXY", "BTC", "ETH", "VIX",
]);

/** Topic → canonical tags mapping */
const TOPIC_TAGS: Record<string, string[]> = {
  energy:              ["WTI", "CRUDE", "ENERGY"],
  trade_policy:        ["ENERGY", "MACRO", "USD"],
  trade_policy_tariff: ["MACRO", "USD", "EQUITIES"],
  federal_reserve:     ["RATES", "MACRO", "EQUITIES"],
  fed_macro:           ["RATES", "MACRO"],
  inflation:           ["MACRO", "RATES", "USD"],
  gdp:                 ["MACRO", "EQUITIES"],
  employment:          ["MACRO", "USD"],
  bond_market:         ["RATES", "MACRO"],
  broad_market:        ["EQUITIES", "MACRO"],
  markets:             ["EQUITIES", "MACRO"],
  crypto:              ["CRYPTO", "MACRO"],
  commodities:         ["COMMODITIES", "MACRO"],
  currency:            ["USD", "MACRO"],
  earnings:            ["EQUITIES"],
  merger_acquisition:  ["EQUITIES", "FINANCIALS"],
  bankruptcy:          ["EQUITIES", "FINANCIALS"],
  ipo:                 ["EQUITIES"],
  layoffs:             ["EQUITIES", "MACRO"],
};

/** Category fallback tags */
const CATEGORY_TAGS: Record<string, string[]> = {
  macro:    ["MACRO"],
  earnings: ["EQUITIES"],
  markets:  ["EQUITIES", "MACRO"],
  policy:   ["MACRO", "RATES"],
  crypto:   ["CRYPTO"],
  other:    ["MACRO"],
};

/**
 * Generate 2–3 validated tags from controlled taxonomy.
 * Uses topic-based mapping first, then scans text for known asset identifiers.
 * Never produces truncated or malformed tags.
 */
function generateTags(
  topicKey: string,
  synthesizedText: string,
  category: string
): string[] {
  const topicNorm = topicKey.toLowerCase().replace(/\s+/g, "_");
  const topicTags = TOPIC_TAGS[topicNorm] ?? [];
  const catTags = CATEGORY_TAGS[category] ?? ["MACRO"];

  // Scan synthesized text for known asset identifiers using word boundaries
  const knownAssets = ["WTI", "CRUDE", "GOLD", "SPX", "DXY", "BTC", "ETH", "VIX"];
  const assetRegex = new RegExp(`\\b(${knownAssets.join("|")})\\b`, "g");
  const textAssets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = assetRegex.exec(synthesizedText)) !== null) {
    textAssets.push(m[1]);
  }

  // Combine: topic tags first (most relevant), then text-found assets, then category fallback
  const combined = [...new Set([...topicTags, ...textAssets, ...catTags])];

  // Validate: only keep tags in the allowed taxonomy
  const valid = combined.filter((t) => ALLOWED_TAGS.has(t));

  return valid.slice(0, 3);
}

function generateId(topic: string): string {
  const hash = topic.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `news-${Date.now()}-${hash}`;
}
