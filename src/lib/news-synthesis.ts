import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, CLAUDE_MODEL } from "./anthropic-client";
import { GroupedNews, NewsItem, NewsSource, KeyDataPoint, ChartDataset, MarketImpactItem, FinnhubArticle, NewsAPIArticle } from "./news-types";
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
        model: CLAUDE_MODEL,
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
 * Lowers confidence threshold from 0.70 to 0.48 so that Tier1 multi-source
 * articles delayed by NewsAPI's free-tier (~24-48h) can still publish on merit.
 */
const REBUILD_MODE = process.env.REBUILD_MODE === "true";

/**
 * Minimum editorial confidence score required to publish (0–1).
 * Production: 0.70 | Rebuild: 0.48
 *
 * Confidence breakdown:
 *   0.30  Tier 1 source present (Reuters, Bloomberg, CNBC, etc.)
 *   0.20  2+ unique sources corroborate the story (0.30 for 3+)
 *   0.20  Story is < 12h old (0.10 for 12-24h)
 *   0.20  Fact-check score ≥ 60
 *
 * Why 0.48 in Rebuild:
 *   NewsAPI free-tier delivers articles 24–48h after publication, so recency is
 *   permanently 0 for every NewsAPI story. The heuristic fact-checker (no Google
 *   Fact Check API key) returns 20–32 for company/event claims, never reaching 60.
 *   Together these permanently cap confidence at 0.50 for Tier1 + 2-source stories
 *   regardless of quality. Setting 0.48 lets Tier1 + 2-source through while still
 *   blocking anything with no tier-1 source or no corroboration.
 *
 *   Minimum achievable scores:
 *     No tier1, 1 source   → 0.00 (blocked) ✓
 *     Tier1, 1 source      → 0.30 (blocked) ✓
 *     No tier1, 2+ sources → 0.20 (blocked) ✓
 *     Tier1 + 2 sources    → 0.50 (passes)  ✓
 */
const CONFIDENCE_THRESHOLD = REBUILD_MODE ? 0.48 : 0.70;

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

  // Source coherence penalty: if grouped articles have low headline overlap,
  // penalize confidence because articles may be about different topics
  if (group.articles.length >= 2) {
    const headlines = group.articles.map((a) => {
      const raw = a as Record<string, unknown>;
      return String(raw.title ?? raw.headline ?? "").toLowerCase();
    });
    const coherence = computeGroupCoherence(headlines);
    // If coherence < 0.15 (very low overlap), apply -0.20 penalty (was -0.15)
    // If coherence < 0.25, apply -0.15 penalty (was -0.10)
    // Strengthened: low-coherence groups produce sector-confused articles
    // (e.g., EPAM IT services mixed with HUM healthcare)
    if (coherence < 0.15) score -= 0.20;
    else if (coherence < 0.25) score -= 0.15;
  }

  return Math.round(Math.min(1.0, Math.max(0, score)) * 100) / 100;
}

/**
 * Compute average pairwise word overlap between headlines in a group.
 * Returns 0–1 where 1 means all headlines share the same words.
 */
function computeGroupCoherence(headlines: string[]): number {
  if (headlines.length < 2) return 1;
  const STOP = new Set(["the","and","for","are","but","not","all","can","was","has","have","been","will","with","this","that","from","they","into","over","said","were","after","about","would","could","also","more","than","just","like","does","some","only"]);

  const wordSets = headlines.map((h) =>
    new Set(h.split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w)))
  );

  let totalOverlap = 0;
  let pairs = 0;
  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const intersection = [...wordSets[i]].filter((w) => wordSets[j].has(w)).length;
      const union = new Set([...wordSets[i], ...wordSets[j]]).size;
      totalOverlap += union > 0 ? intersection / union : 0;
      pairs++;
    }
  }
  return pairs > 0 ? totalOverlap / pairs : 0;
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
/**
 * Normalize a raw line from Claude's output so that section headers are
 * recognized regardless of casing, markdown formatting, or minor variations.
 *
 * Handles common Claude output quirks:
 *   - "**HEADLINE:**" → "HEADLINE:"
 *   - "## HEADLINE:" → "HEADLINE:"
 *   - "Headline:" or "headline:" → "HEADLINE:"
 *   - "TITLE:" → "HEADLINE:" (common alias)
 *   - Leading markdown fences (```) are stripped
 */
function normalizeHeaderLine(trimmed: string): string {
  // Strip markdown bold/italic wrappers: **HEADLINE:** → HEADLINE:
  let s = trimmed.replace(/^\*{1,3}|\*{1,3}$/g, "").trim();
  // Strip markdown heading prefixes: ## HEADLINE: → HEADLINE:
  s = s.replace(/^#{1,4}\s*/, "").trim();
  // Strip code fences
  if (s.startsWith("```")) return "";
  // Uppercase everything before the first colon for header matching
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0 && colonIdx < 20) {
    const label = s.substring(0, colonIdx).toUpperCase().trim();
    const rest = s.substring(colonIdx + 1);
    // Map common aliases
    if (label === "TITLE") return `HEADLINE:${rest}`;
    return `${label}:${rest}`;
  }
  return s;
}

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

  // Log first 300 chars of raw output for debugging parse failures
  const preview = raw.substring(0, 300).replace(/\n/g, "\\n");
  console.log(`[parse] Raw output preview (${raw.length} chars): "${preview}"`);

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
    // Normalize for header detection (case-insensitive, strips markdown)
    const normalized = normalizeHeaderLine(trimmed);

    // Named section headers — always processed first
    if (normalized.startsWith("HEADLINE:")) {
      inKeyTakeaways = false;
      inMarketImpact = false;
      result.title = normalized.replace("HEADLINE:", "").trim();
      continue;
    }
    if (normalized.startsWith("KEY_TAKEAWAYS:")) {
      inKeyTakeaways = true;
      inMarketImpact = false;
      // Handle inline bullet on same line: "KEY_TAKEAWAYS: • First point"
      const remainder = normalized.replace("KEY_TAKEAWAYS:", "").trim();
      if (remainder) {
        const bullet = remainder.replace(/^[•\-\*]\s*/, "").trim();
        if (bullet) result.keyTakeaways.push(bullet);
      }
      continue;
    }
    if (normalized.startsWith("WHY_MATTERS:")) {
      inKeyTakeaways = false;
      inMarketImpact = false;
      result.whyThisMatters = normalized.replace("WHY_MATTERS:", "").trim();
      continue;
    }
    if (normalized.startsWith("SECOND_ORDER:")) {
      inKeyTakeaways = false;
      inMarketImpact = false;
      result.secondOrderImplication = normalized.replace("SECOND_ORDER:", "").trim();
      continue;
    }
    if (normalized.startsWith("WHAT_WATCH:")) {
      inKeyTakeaways = false;
      inMarketImpact = false;
      result.whatToWatchNext = normalized.replace("WHAT_WATCH:", "").trim();
      continue;
    }
    if (normalized.startsWith("MARKET_IMPACT:")) {
      inKeyTakeaways = false;
      inMarketImpact = true;
      // Handle inline: "MARKET_IMPACT: OIL +4.1% up, S&P -1.2% down"
      const remainder = normalized.replace("MARKET_IMPACT:", "").trim();
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
      const isHeader = HEADER_PREFIXES.some((p) => normalized.startsWith(p));
      if (!isHeader) {
        storyLines.push(trimmed);
        inStory = true;
      }
    }
  }

  result.story = storyLines.join("\n\n");

  // ── Fallback title extraction ──────────────────────────────────────────
  // If no HEADLINE: section was found (title === fallbackTitle), try to
  // extract a reasonable title from the first substantive line of the output.
  // Claude sometimes omits the HEADLINE: prefix but writes a title-like
  // first line (short, no period, capitalized).
  if (result.title === fallbackTitle || !result.title || result.title.length < 5) {
    // Strategy 1: first non-empty line that looks like a title (5-18 words, no period)
    for (const line of lines) {
      const t = line.trim()
        .replace(/^\*{1,3}/, "").replace(/\*{1,3}$/, "") // strip bold
        .replace(/^#{1,4}\s*/, "")                         // strip heading markers
        .trim();
      if (!t || t.startsWith("```")) continue;
      // Skip lines that are clearly section headers we already processed
      const n = normalizeHeaderLine(t);
      if (HEADER_PREFIXES.some((p) => n.startsWith(p))) continue;
      // Skip bullet points
      if (/^[•\-\*]/.test(t)) continue;
      const words = t.split(/\s+/).filter(Boolean);
      // Title-like: 5-18 words, doesn't end with a period (prose), not too long
      if (words.length >= 5 && words.length <= 18 && !t.endsWith(".") && t.length < 200) {
        result.title = t;
        console.log(`[parse] Fallback title extracted from first line: "${t}"`);
        break;
      }
    }

    // Strategy 2: first sentence (existing logic)
    if (result.title === fallbackTitle || !result.title || result.title.length < 5) {
      const firstSentence = raw.split(/[.!?]/)[0].trim();
      if (firstSentence.length > 10 && firstSentence.length < 150) {
        const words = firstSentence.split(/\s+/).filter(Boolean);
        if (words.length >= 5) {
          result.title = firstSentence;
          console.log(`[parse] Fallback title from first sentence: "${firstSentence}"`);
        }
      }
    }
  }

  if (!result.story || result.story.length < 100) {
    const bodyLines = lines.filter((l) => {
      const n = normalizeHeaderLine(l.trim());
      return (
        !HEADER_PREFIXES.some((p) => n.startsWith(p)) &&
        !l.trim().startsWith("•") &&
        !l.trim().startsWith("```")
      );
    });
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

STANDALONE ARTICLE MANDATE (CRITICAL)
Every article must be a standalone analytical piece, not an incremental update to a previous story.

Rules:
- NEVER write an "update" article. Each piece must stand alone as if the reader has no prior context.
- NEVER use update language: "continues to", "remains elevated", "still above", "persists", "ongoing"
- If the sources describe an ongoing situation (e.g., a multi-day oil spike), analyze the STRUCTURAL IMPLICATIONS rather than restating what happened:
  BAD: "Oil prices remain elevated above $95 as Iran tensions continue to weigh on markets."
  GOOD: "A sustained $95 floor for WTI crude is compressing refining margins and forcing airlines to hedge at levels not seen since 2022."
- Each article must have a DISTINCT THESIS that is not merely "X is still happening."
  BAD THESIS: "Iran tensions continue to push oil prices higher."
  GOOD THESIS: "Sustained crude above $95 is triggering a repricing of airline and shipping equities that markets have not yet fully absorbed."
- Test: If the headline could have been published yesterday on the same story, the thesis is too generic. Rewrite.
- The thesis must identify a NEW CONSEQUENCE, a new data point, a new sector implication, or a new comparison that distinguishes this analysis from prior coverage.

EDITORIAL INDEPENDENCE
Each article must offer a genuinely differentiated analytical perspective:
- Identify the non-obvious implication: What does this event mean for a sector, asset class, or policy outlook that the headlines have not covered?
- Name specific second-order effects: If oil rises, do not just say "inflation risk." Name which CPI subcomponents are affected, which sectors face margin compression, and which rate expectations shift.
- Provide a concrete forward-looking signal: Not "watch for volatility" but "the March FOMC dot plot and April CPI print will determine whether the 10-year holds above 4.5%."

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
2 Section 1 (Event Summary): Open with the single most important fact. Inverted pyramid. Most impactful number first. Write in the style of a Reuters flash or FT front-page lede: one sentence, one number, one consequence.
3 Section 2 (Market Reaction): How markets responded in price terms. Specific index, sector, or asset moves with percentages or basis points. Name at least 2 specific assets or indices. Bloomberg Markets standard: "The S&P 500 fell 1.2%, led by energy names including Exxon (down 3.1%) and Chevron (down 2.8%)."
4 Section 3 (Macro Analysis): Why this happened. Economic context, precedent, and the broader macro narrative. Include a historical comparison or prior-period reference (e.g., "the largest single-day move since March 2023" or "the third consecutive month above the Fed's 2% target"). Bloomberg/FT standard: connect the event to the macro cycle, not just the headline.
5 Section 4 (Investor Implications): Which sectors, tickers, or strategies benefit or suffer. Name specific assets. Barron's standard: name at least one ETF, sector, or strategy that benefits and one that faces headwinds. Include a specific price level, valuation multiple, or spread that supports the call.
6 Section 5 (What to Watch Next): The most important catalyst or data point to monitor over the next 1–4 weeks. CNBC/Reuters standard: name the specific date, event, or data release (e.g., "March 19 FOMC statement" or "April 10 CPI print"). Do not write vague catalysts like "upcoming data releases" or "future Fed decisions."
7 Separate each section with a blank line. Do NOT label sections with headers.
8 Use specific numbers, company names, dates, and percentage figures from the sources
9 Include at least FIVE numerical data points distributed across the story body (not clustered in one paragraph)
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

DATA CONSISTENCY (Step 12c)
When the MARKET DATA section provides specific figures, you MUST use those exact figures throughout. Never:
- Round differently in different sections (e.g., "$92.3" in one place and "$92" in another)
- State a figure as a level in one paragraph and as a change in another without making the relationship clear
- Use a stale figure from a source article when a fresher figure is in MARKET DATA
- Quote a percentage move from yesterday's close when MARKET DATA shows a different reference point

Cross-reference rule: When writing about multiple related metrics (e.g., oil price AND inflation AND rate expectations), ensure the causal chain is internally consistent. If you say oil is at $95, and this feeds through to inflation, the inflation figure you cite must be consistent with an oil price at that level.

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
□ STANDALONE CHECK: Could this article have been published yesterday on the same event? If yes, the thesis is too generic — rewrite with a distinct angle.
□ UPDATE LANGUAGE CHECK: Does the article use "continues to", "remains", "still", "ongoing", "persists"? If yes, reframe around a new consequence or data point.
□ BENCHMARK CHECK: Would this fit on the front page of Bloomberg Markets or Barron's "Up and Down Wall Street"? If it reads like a wire recap, add analytical depth.

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
- Do not invent new tags outside this list

CLAIM PRECISION VALIDATION (Step 19a)
Never state unsourced quantitative rules or sensitivity ratios as if they are universal financial laws.
- BAD: "Every 25 basis point increase in the risk-free rate reduces the present value of healthcare cash flows by 2 to 3 percent."
- GOOD: "Higher risk-free rates reduce the present value of longer-duration cash flows, and when yields rise alongside negative earnings revisions, the valuation impact compounds."
- If you cite a specific sensitivity ratio (e.g., "every X bp move = Y% valuation impact"), it MUST come from a named source (analyst report, MARKET DATA, or quoted research). Otherwise, use directional language.
- Quantitative claims require attribution. Unattributed precision undermines credibility.

COMPANY AND SECTOR RELEVANCE (Step 19b)
Every company, ticker, or entity mentioned in the story must be directly relevant to the thesis and sector.
- Do NOT introduce companies from unrelated sectors as comparative examples. A managed care story should reference managed care peers (UNH, CNC, CI, ELV), not diversified financials (PRU, MET) unless the thesis specifically spans both sectors.
- Before including a company example, verify: (1) Is this company in the same sector as the thesis? (2) Does its inclusion strengthen the analytical argument? (3) Would removing it weaken the story?
- If a company fails these tests, replace it with a relevant peer or remove the reference entirely.
- Cross-sector comparisons are permitted ONLY when the thesis is explicitly about cross-sector dynamics (e.g., "rate sensitivity across healthcare and financials").

POLICY INTERPRETATION RULE (Step 19c)
Do not assert monetary policy conclusions from rate levels alone.
- BAD: "The Fed Funds Rate at 3.64% suggests that rate cuts are unlikely in the near term."
- GOOD: "With the Fed Funds Rate at 3.64%, futures markets reflect limited expectations for near-term cuts."
- Rate levels do not inherently prove policy direction. Reference market pricing (fed funds futures, CME FedWatch), official forward guidance, or analyst consensus when making policy claims.
- Prefer "markets are pricing in", "futures imply", or "consensus expects" over asserting conclusions from rate levels.

CHART-THESIS ALIGNMENT (Step 19d)
Every chart must directly reinforce the article's central thesis.
- Before including a chart, verify: Does this chart illustrate a key data trend that supports the thesis?
- Do not include charts about tangentially related metrics. A managed care margin story should chart yield trends, MLR ratios, or HUM share price — not unrelated sector indices.
- If no chart data directly supports the thesis, it is better to include no chart than an irrelevant one.

THESIS CLARITY (Step 19e)
The first paragraph must contain one clear thesis sentence that a reader can identify without ambiguity.
- The thesis must be falsifiable — it makes a specific claim that could be wrong, not a vague observation.
- BAD THESIS: "Rising rates are creating challenges for the healthcare sector."
- GOOD THESIS: "Bernstein's target cut on Humana reflects a broader repricing of managed care valuations as the 4.27% 10-year yield compresses Medicare Advantage margins already under CMS Stars pressure."
- Test: Can you summarize the article's argument in one sentence? That sentence should appear in paragraph one.`;
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

  // Detect thin sources and add supplementary instruction
  const totalSourceChars = formattedArticles.reduce(
    (sum, a) => sum + (a.summary?.length ?? 0), 0
  );
  const thinSourcesNote = totalSourceChars < 400
    ? `\nIMPORTANT: The source summaries are brief. Lean heavily on the MARKET DATA section above to write a substantive, data-grounded analysis. Do NOT refuse to write — always produce a complete article in the required format. The SOURCES provide the event; the MARKET DATA provides the numbers; your analysis connects them. Do NOT invent numbers or facts not present in the SOURCES or MARKET DATA.`
    : "";

  return `Write one cohesive financial news story about "${group.topic}"

SOURCES (synthesize all — do not simply summarize one):
${articleTexts}
${dataContext}
${thinSourcesNote}

SOURCE RELEVANCE: Some sources in the list above may not be directly related to the main story. Use ONLY sources that are relevant to the cohesive narrative. Do NOT force unrelated sources into the story — ignore them if they don't fit the topic.

SECTOR COHERENCE (CRITICAL): If the sources span different sectors or industries (e.g., a healthcare analyst downgrade alongside an IT services price target raise), write about the DOMINANT topic only. Do NOT synthesize companies from unrelated sectors into a single narrative. Specifically:
- Never characterize a company as belonging to a sector it does not belong to (e.g., do not call an IT services company a "healthcare play")
- If a source is about a company in a different sector, IGNORE it completely
- The article must be about ONE coherent sector or theme

Editorial angle: ${angle}

CRITICAL: You MUST output your response starting with "HEADLINE:" followed by the headline. Do not add any preamble, commentary, or refusal before the HEADLINE line. Always produce the full structured output.

HEADLINE RULES:
- The headline MUST name specific companies, people, or data points (e.g., "Bernstein Cuts Humana Target as Stars Deterioration Widens Managed Care Margins" NOT "Healthcare Analysts Cut Targets")
- Avoid generic sector labels without specifics
- 8–14 words, no filler words ("amid", "as", "despite" are OK as connectors but not as the main verb)
- The headline should make a reader want to click — convey the "so what" not just the "what"

MARKET_IMPACT RULES:
- You MUST include MARKET_IMPACT with 1–3 specific asset bullets
- Each bullet format: "• TICKER CHANGE DIRECTION" (e.g., "• HUM -3.2% down")
- Use actual ticker symbols (HUM, PRU, AAPL, SPY, etc.) not generic labels like "OIL" or "MACRO"
- Only list assets that appear in your story or MARKET DATA

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
  stats: { posted: number; rejected: number; errors: number; preRejected: number; rejectionDetails: string[]; rejectedTopics: string[] };
}> {
  const stories: NewsItem[] = [];
  const stats = { posted: 0, rejected: 0, errors: 0, preRejected: 0, rejectionDetails: [] as string[], rejectedTopics: [] as string[] };

  const toneProfile = await getToneProfile();
  const client = getAnthropicClient();

  // Per-run image cache — avoid duplicate Unsplash API calls for same topic
  const runImageCache = new Map<string, string>();

  // Track chart budgets.
  // MAX_CHARTS_PER_RUN = 9  — supports up to 3 articles × 3 charts each.
  // MAX_CHARTS_PER_ARTICLE = 3 — caps charts per story so no single article hogs the budget.
  let chartCount = 0;
  const MAX_CHARTS_PER_RUN = 9;
  const MAX_CHARTS_PER_ARTICLE = 3;

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
        stats.rejectedTopics.push(group.topic);
        console.warn(
          `[synthesis] Pre-synthesis reject "${group.topic}": ${worthiness.reason}`
        );
        continue;
      }

      const formattedArticles = formatNewsForStorage(group.articles);

      // ── Pre-synthesis content gate ─────────────────────────────────────
      // Skip groups where articles have insufficient body content (headline-only).
      // Claude refuses to write from just headlines, wasting API credits.
      //
      // Two-tier check:
      //   1. Total chars ≥ 400 across all articles (raised from 100 — two 150-char
      //      headlines sum to ~300 chars and still produce Claude refusals)
      //   2. At least one article must have ≥ 150 chars of body text (not just a
      //      headline repeated across two outlets)
      const totalSummaryChars = formattedArticles.reduce(
        (sum, a) => sum + (a.summary?.length ?? 0), 0
      );
      const maxSingleArticleChars = formattedArticles.reduce(
        (max, a) => Math.max(max, a.summary?.length ?? 0), 0
      );
      if (totalSummaryChars < 400 || maxSingleArticleChars < 150) {
        stats.preRejected++;
        stats.rejectedTopics.push(group.topic);
        console.warn(
          `[synthesis] Content-gate reject "${group.topic}" — ` +
          `total=${totalSummaryChars} chars (need ≥400), maxSingle=${maxSingleArticleChars} chars (need ≥150). ` +
          `Articles appear to be headline-only stubs; skipping to save API credits.`
        );
        continue;
      }

      console.log(
        `[synthesis] Processing: "${group.topic}" (${group.articles.length} sources, importance=${group.importance}, summaryChars=${totalSummaryChars})`
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

      // ── Refusal detection ──────────────────────────────────────────────
      // Claude sometimes refuses to write when source materials are too thin.
      // Two-pronged check:
      //   1. Regex anchors on synthesizedText.substring(0, 400) — catches clean refusals
      //   2. substring().includes() fallback — catches refusals with leading whitespace
      //      or invisible chars that could defeat the ^ anchor
      const firstLine = synthesizedText.split("\n")[0].trim().toLowerCase();
      const head400 = synthesizedText.substring(0, 400);
      const head400Lower = head400.toLowerCase().trimStart();
      const REFUSAL_PATTERNS = [
        /^i cannot/i,
        /^i'm unable/i,
        /^i apologize/i,
        /^unfortunately,? i/i,
        /^i don't have enough/i,
        /^the source materials? (provided )?(contain|do not|don't|lack)/i,
        /^i can't write/i,
        /^there is insufficient/i,
      ];
      const REFUSAL_SUBSTRINGS = [
        "i cannot write this article",
        "i cannot write an article",
        "i'm unable to write",
        "i can't write this article",
        "the source materials provided contain only",
        "both sources are identical stub",
        "insufficient source content",
        "only a headline",
      ];
      const isRefusal =
        REFUSAL_PATTERNS.some((p) => p.test(head400)) ||
        REFUSAL_SUBSTRINGS.some((s) => head400Lower.includes(s));
      if (isRefusal) {
        stats.errors++;
        stats.rejectedTopics.push(group.topic);
        console.warn(
          `[synthesis] Claude refused to write "${group.topic}" — ` +
          `likely insufficient source content. First line: "${firstLine.substring(0, 100)}"`
        );
        continue;
      }

      console.log(`[synthesis] Generated ${synthesizedText.length} chars for "${group.topic}"`);

      // Parse structured output FIRST — fact-check needs parsed story body,
      // not raw Claude output (which contains HEADLINE:/KEY_TAKEAWAYS:/etc. prefixes)
      const parsed = parseStructuredOutput(synthesizedText, group.topic);

      // Validate required fields
      // Word-count check (not char-length) — catches fallback-to-topic-key cases.
      const titleWords = parsed.title?.trim().split(/\s+/).filter(Boolean) ?? [];
      if (!parsed.title || parsed.title.length < 5 || titleWords.length < 5) {
        stats.errors++;
        console.error(
          `[synthesis] Failed to parse headline for "${group.topic}" — ` +
          `got "${parsed.title}" (${titleWords.length} words). ` +
          `Claude output likely missing HEADLINE: prefix.`
        );
        continue;
      }

      if (!parsed.story || parsed.story.length < 100) {
        stats.errors++;
        console.error(`[synthesis] Story body too short for "${group.topic}"`);
        continue;
      }

      // Fact-check — extract claims from PARSED STORY BODY (not raw output)
      const claims = extractClaimsFromStory(parsed.story);
      const { results: factCheckResults, overallScore } = await verifyClaims(claims);
      const adjustedScore = scoreFactCheckResult(factCheckResults);

      // Log claim-to-source mapping for transparency
      if (factCheckResults.length > 0) {
        console.log(`[synthesis] Fact-check for "${group.topic}": score=${overallScore} (adjusted=${adjustedScore})`);
        for (const r of factCheckResults) {
          const status = r.verified ? "✓" : "✗";
          const src = r.sources && r.sources.length > 0 ? ` [${r.sources[0]}]` : "";
          console.log(`  ${status} "${r.claim.substring(0, 60)}..." — confidence=${r.confidence}${src}`);
        }
      }

      // Reject if adjusted score too low
      const FACT_CHECK_THRESHOLD = REBUILD_MODE ? 20 : 55;
      if (shouldRejectStory(adjustedScore, FACT_CHECK_THRESHOLD)) {
        stats.rejected++;
        const reason = `"${group.topic}" fact-check ${adjustedScore} < ${FACT_CHECK_THRESHOLD}`;
        stats.rejectionDetails.push(reason);
        stats.rejectedTopics.push(group.topic);
        console.warn(`[synthesis] Rejected ${reason}`);
        logRejection(group.topic, `Fact check score: ${adjustedScore}`, adjustedScore);
        continue;
      }

      // Confidence score — composite quality gate
      const groupHasTier1 = hasQualitySource(group.articles);
      const confidenceScore = computeConfidenceScore(group, overallScore, groupHasTier1);
      if (confidenceScore < CONFIDENCE_THRESHOLD) {
        stats.rejected++;
        const reason = `"${group.topic}" confidence ${confidenceScore} < ${CONFIDENCE_THRESHOLD} (tier1=${groupHasTier1}, sources=${group.articles.length}, factCheck=${overallScore})`;
        stats.rejectionDetails.push(reason);
        stats.rejectedTopics.push(group.topic);
        console.warn(`[synthesis] Rejected — ${reason}`);
        logRejection(group.topic, `Confidence score: ${confidenceScore}`, adjustedScore);
        continue;
      }
      console.log(`[synthesis] Confidence check passed: "${group.topic}" — score=${confidenceScore}`);

      // ── Image resolution (Editorial Match Rule) ───────────────────────────
      // Step 1: Detect the story's true subject regardless of topic categorization.
      //
      //   Rule A — Oil/Energy: Oil stories must use oil infrastructure imagery,
      //   never generic NYSE floors or renewable energy visuals (wind turbines,
      //   solar panels). Applies even when the article is categorized as
      //   "broad_market", "geopolitics", "macro", etc.
      //
      //   Rule B — Crypto: Crypto stories must use crypto/blockchain imagery,
      //   never city skylines (GDP fallback) or trading floors. A geopolitics
      //   article that is really about Bitcoin price action needs a Bitcoin image.
      //
      const articleTitles = group.articles.map((a) => {
        const raw = a as Record<string, unknown>;
        return String(raw.title ?? raw.headline ?? "");
      }).join(" ");

      const topicAndTitles = group.topic + " " + articleTitles;

      // Rule A: mis-categorized oil/energy story
      const isOilStory =
        group.topic !== "energy" &&
        /\boil\b|crude\b|WTI\b|brent\b|OPEC\b|petroleum\b|refin(er|ery)\b/i.test(
          topicAndTitles
        );

      // Rule B: mis-categorized crypto story — catch "bitcoin", "BTC", "ethereum",
      //   "ETH", "crypto", "blockchain", "DeFi", "stablecoin" in geopolitics/
      //   macro/broad_market articles. City skyline images (GDP/macro fallback)
      //   must never appear on crypto stories.
      const isCryptoStory =
        group.topic !== "crypto" &&
        /\bbitcoin\b|\bBTC\b|\bethereum\b|\bETH\b|\bcrypt(?:o|ocurrency)\b|\bblockchain\b|\bDeFi\b|\bstablecoin\b|\bNFT\b/i.test(
          topicAndTitles
        );

      // Rule C: mis-categorized trade/tariff story — catch tariff/trade war keywords
      //   in macro/broad_market articles. Trade stories need shipping/port imagery,
      //   not generic NYSE trading floor images.
      const isTradeStory =
        !["trade_policy", "trade_policy_tariff"].includes(group.topic) &&
        /\btariff\b|\btrade\s+war\b|\btrade\s+policy\b|\bcustoms?\b|\bimport\s+dut/i.test(
          topicAndTitles
        );

      // Step 2: Pick Unsplash query — override for mis-categorized stories.
      //   Oil story beats crypto story (energy is primary driver if both match).
      //   Trade/tariff beats generic macro. Oil beats all.
      const imageTopicOverride = isOilStory ? "energy" : isCryptoStory ? "crypto" : isTradeStory ? "trade_policy" : group.topic;

      if (isOilStory) {
        console.log(
          `[synthesis] Image override: "${group.topic}" → "energy" (oil keywords detected in titles)`
        );
      } else if (isCryptoStory) {
        console.log(
          `[synthesis] Image override: "${group.topic}" → "crypto" (crypto keywords detected in titles)`
        );
      } else if (isTradeStory) {
        console.log(
          `[synthesis] Image override: "${group.topic}" → "trade_policy" (trade/tariff keywords detected in titles)`
        );
      }
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

      // ── Chart generation — Phase 1: topic-driven primary + companion ────────
      // Attempts to build a chart directly from the story's topic key (FRED/EIA/BLS).
      // Energy stories also get a bond-market companion; rate stories get equities.
      // Optional DXY tertiary when dollar is explicitly discussed.
      let chartData: ChartDataset[] | undefined;
      let articleChartCount = 0;
      const topicNorm = group.topic.toLowerCase().replace(/\s+/g, "_");
      // Track which topics are already charted to avoid duplicates in Phase 2.
      const articleChartedTopics = new Set<string>();

      if (chartCount < MAX_CHARTS_PER_RUN && articleChartCount < MAX_CHARTS_PER_ARTICLE) {
        const primary = await buildChartData(group.topic);
        if (primary) {
          chartCount++;
          articleChartCount++;
          articleChartedTopics.add(topicNorm);
          chartData = [primary];

          // Companion chart routing — topic-aware secondary pairing
          const secondaryTopic =
            topicNorm === "energy" || topicNorm === "trade_policy" ? "bond_market" :
            topicNorm === "bond_market" || topicNorm === "federal_reserve" || topicNorm === "fed_macro" ? "broad_market" :
            null;

          if (secondaryTopic && chartCount < MAX_CHARTS_PER_RUN && articleChartCount < MAX_CHARTS_PER_ARTICLE) {
            const secondary = await buildChartData(secondaryTopic);
            if (secondary) {
              const primaryPos = primary.insertAfterParagraph ?? 0;
              secondary.insertAfterParagraph = Math.max(primaryPos + 2, 2);
              if (!secondary.chartLabel) secondary.chartLabel = "MARKET CONTEXT";
              chartCount++;
              articleChartCount++;
              articleChartedTopics.add(secondaryTopic);
              chartData.push(secondary);
            }
          }

          // Optional tertiary DXY chart: add when article explicitly references dollar strength/weakness
          const dollarMentions = (synthesizedText.match(/\b(dollar|USD|DXY|greenback|dollar\s+index|currency)\b/gi) ?? []).length;
          const topicSupportsDxy = ["energy", "trade_policy", "trade_policy_tariff", "inflation", "federal_reserve", "fed_macro"].includes(topicNorm);
          if (dollarMentions >= 2 && topicSupportsDxy && chartCount < MAX_CHARTS_PER_RUN && articleChartCount < MAX_CHARTS_PER_ARTICLE) {
            const dxy = await buildChartData("dxy");
            if (dxy) {
              const lastPos = chartData[chartData.length - 1]?.insertAfterParagraph ?? 2;
              dxy.insertAfterParagraph = Math.min(lastPos + 2, 4);
              if (!dxy.chartLabel) dxy.chartLabel = "CURRENCY";
              chartCount++;
              articleChartCount++;
              articleChartedTopics.add("dxy");
              chartData.push(dxy);
            }
          }
        }
      }

      // ── Phase 2: Content-based chart detection ───────────────────────────────
      // Guarantees 2-4 charts per article by scanning the synthesized text for
      // explicit mentions of market variables. Adds a data-backed chart for each
      // referenced variable not already covered by the topic-driven charts above.
      //
      // This closes the "geopolitics → no FRED mapping → zero charts" gap: an
      // Iran/oil article categorised as "geopolitics" gets an OIL PRICES chart
      // because oil keywords appear in the body, even though buildChartData("geopolitics")
      // returns null.
      //
      // Keyword thresholds are intentionally low (1-2 hits) because financial
      // articles reference macro variables often in passing. The data behind the
      // chart is fetched from live APIs (EIA/FRED/BLS) so every chart is accurate
      // and fact-checked regardless of how many times the keyword appears.
      const contentChartCandidates: Array<{
        topic: string;
        label: string;
        minMatches: number;
        pattern: RegExp;
      }> = [
        {
          topic: "energy",
          label: "OIL PRICES",
          minMatches: 1,
          pattern: /\b(oil|crude\s+oil|WTI|brent|OPEC|petroleum|energy prices?|barrels?)\b/gi,
        },
        {
          topic: "inflation",
          label: "INFLATION",
          minMatches: 2,
          pattern: /\b(inflation|CPI|PCE|consumer prices?|price levels?|price pressures?|breakeven|inflationary)\b/gi,
        },
        {
          topic: "bond_market",
          label: "RATES",
          minMatches: 2,
          pattern: /\b(interest rates?|yields?|10-year|Treasury|bonds?|rate cuts?|rate hikes?|fed funds|monetary policy|basis points?)\b/gi,
        },
        {
          topic: "broad_market",
          label: "EQUITIES",
          // Raised from 2→4: sector-specific articles (earnings, healthcare) mention
          // "equities" or "S&P 500" in passing without being about the broad market.
          // A threshold of 4 ensures the S&P 500 chart only fires when the article
          // genuinely discusses broad market dynamics, not just references them.
          minMatches: 4,
          pattern: /\b(S&P\s*500?|Nasdaq|Dow Jones|Dow\b|equit(?:y|ies)|stock market|market rall(?:y|ied)|market sell.?off|risk.?off|risk.?on)\b/gi,
        },
        {
          topic: "currency",
          label: "DOLLAR INDEX",
          minMatches: 2,
          pattern: /\b(dollar|USD|DXY|greenback|dollar index|trade.?weighted|strong dollar|weak dollar|king dollar)\b/gi,
        },
        {
          topic: "broad_market",
          label: "VIX / VOLATILITY",
          minMatches: 2,
          pattern: /\b(VIX|volatility index|CBOE|implied volatility|vol spike|fear gauge|risk premium|volatility)\b/gi,
        },
        {
          topic: "employment",
          label: "LABOR MARKET",
          minMatches: 2,
          pattern: /\b(unemployment|jobless|non.?farm payrolls?|NFP|labor market|jobs report|hiring|layoffs|initial claims|employment)\b/gi,
        },
      ];

      // Ensure chartData is an array so we can push into it
      if (!chartData) chartData = [];

      for (const candidate of contentChartCandidates) {
        if (articleChartCount >= MAX_CHARTS_PER_ARTICLE) break;
        if (chartCount >= MAX_CHARTS_PER_RUN) break;
        if (articleChartedTopics.has(candidate.topic)) continue;

        const matches = (synthesizedText.match(candidate.pattern) ?? []).length;
        if (matches < candidate.minMatches) continue;

        const chart = await buildChartData(candidate.topic);
        if (!chart) continue;

        // Space charts evenly across the 5-paragraph article body (positions 1–4)
        const lastPos = chartData.length > 0
          ? (chartData[chartData.length - 1].insertAfterParagraph ?? 0)
          : 0;
        chart.insertAfterParagraph = Math.min(lastPos + 1, 4);
        chart.chartLabel = candidate.label;
        chartCount++;
        articleChartCount++;
        articleChartedTopics.add(candidate.topic);
        chartData.push(chart);
        console.log(
          `[synthesis] Content chart "${candidate.label}" → "${group.topic}" ` +
          `(${matches} keyword hits in synthesized text)`
        );
      }

      // Collapse empty chartData to undefined — avoids storing [] in the article record
      if (chartData.length === 0) chartData = undefined;

      // Infer category from synthesized content (more accurate than source-level inference)
      const inferredCategory = inferCategoryFromContent(parsed.story, parsed.title, group.topic);

      const newsItem: NewsItem = {
        id: generateId(group.topic),
        title: parsed.title,
        story: parsed.story,
        category: inferredCategory,
        topicKey: group.topic,
        imageUrl,
        publishedAt: new Date().toISOString(),
        importance: group.importance,
        sentiment: inferSentiment(synthesizedText),
        relatedTickers: generateTags(group.topic, synthesizedText, group.category),
        sourcesUsed: filterRelevantSources(group.articles, parsed.story, parsed.title),
        factCheckScore: overallScore,
        verifiedClaims: factCheckResults
          .filter((r) => r.verified)
          .map((r) => r.claim)
          .slice(0, 3),
        // Editorial enrichment
        whyThisMatters: parsed.whyThisMatters || undefined,
        whatToWatchNext: parsed.whatToWatchNext || undefined,
        secondOrderImplication: parsed.secondOrderImplication || undefined,
        keyDataPoints: contextualData.length > 0 ? contextualData : undefined,
        chartData,
        keyTakeaways: parsed.keyTakeaways.length > 0 ? parsed.keyTakeaways : undefined,
        confidenceScore,
        // Event-first architecture — filter marketImpact to valid format only
        // Parser already enforces +/-N.N% or +/-Nbps, but defensive filter
        // catches any manually injected or edge-case bad formats
        marketImpact: parsed.marketImpact.length > 0
          ? parsed.marketImpact.filter((mi) =>
              /^[+\-]\d+[.,]?\d*\s*(%|bps|bp)$/i.test(mi.change.trim())
            )
          : undefined,
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
        const failedTests = qaResult.tests
          .filter((t) => !t.passed)
          .map((t) => `${t.test}(${t.score}/${t.maxScore})`)
          .join(", ");
        const reason = `"${parsed.title}" QA ${qaResult.score}/${QA_PASS_THRESHOLD} — failed: ${failedTests}`;
        stats.rejectionDetails.push(reason);
        stats.rejectedTopics.push(group.topic);
        console.warn(`[synthesis] QA gate rejected — ${reason}`);
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

/**
 * Filter source articles to only include those whose headline has meaningful
 * overlap with the synthesized article content. Prevents listing irrelevant
 * sources (e.g., a Hamas article cited for a healthcare story).
 * Returns at least 1 source (falls back to the best-matching one).
 */
function filterRelevantSources(
  articles: (FinnhubArticle | NewsAPIArticle)[],
  story: string,
  title: string
): NewsSource[] {
  const articleText = `${title} ${story}`.toLowerCase();

  // Extract significant words from the synthesized article (4+ chars, no stopwords)
  const STOP = new Set(["the","and","for","are","but","not","all","can","had","was","one","has","have","been","will","with","this","that","from","they","than","into","over","such","what","when","how","each","which","their","said","were","after","about","would","could","should","also","more","than","most","other","some","only","very","just","like","these","those","does","been"]);
  const articleWords = new Set(
    articleText.split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w))
  );

  type ScoredSource = { source: NewsSource; score: number };
  const scored: ScoredSource[] = articles.map((article) => {
    const fmt = formatNewsForStorage([article])[0];
    const srcHeadline = fmt.title.toLowerCase();
    const srcWords = srcHeadline.split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w));
    // Count how many headline words appear in the synthesized article
    const overlap = srcWords.filter((w) => articleWords.has(w)).length;
    const score = srcWords.length > 0 ? overlap / srcWords.length : 0;
    return {
      source: { title: fmt.title, url: fmt.url, source: fmt.source },
      score,
    };
  });

  // Cross-sector contamination guard: if a source headline names a ticker
  // that doesn't appear anywhere in the synthesized article, halve its score.
  // This catches cases where generic financial vocabulary ("stock", "price",
  // "target") inflates overlap for unrelated companies (e.g., EPAM in a healthcare article).
  const TICKER_PATTERN = /\b[A-Z]{2,5}\b/g;
  const TICKER_STOPWORDS = new Set(["THE", "FOR", "AND", "NOT", "ALL", "ARE", "BUT", "ITS", "HAS", "WAS", "NEW", "CEO", "IPO", "ETF", "GDP", "CPI", "FED"]);
  for (const s of scored) {
    const headlineTickers = (s.source.title.match(TICKER_PATTERN) ?? [])
      .filter((t) => t.length >= 2 && !TICKER_STOPWORDS.has(t));
    if (headlineTickers.length > 0) {
      const tickerInArticle = headlineTickers.some((t) => articleText.includes(t.toLowerCase()));
      if (!tickerInArticle) {
        s.score *= 0.5;
      }
    }
  }

  // Keep sources with ≥30% headline word overlap with synthesized article
  const relevant = scored.filter((s) => s.score >= 0.3);

  if (relevant.length > 0) {
    return relevant.map((s) => s.source);
  }

  // Fallback: return the single best-matching source
  scored.sort((a, b) => b.score - a.score);
  return [scored[0].source];
}

/**
 * Infer article category from the synthesized content and topic key.
 * Uses the final article text (more accurate than source-level inference).
 */
function inferCategoryFromContent(
  story: string,
  title: string,
  topicKey: string
): "macro" | "earnings" | "markets" | "policy" | "crypto" | "other" {
  // 1. Topic key directly maps to category (most reliable)
  const topicCategoryMap: Record<string, "macro" | "earnings" | "markets" | "policy" | "crypto"> = {
    federal_reserve: "macro", fed_macro: "macro", inflation: "macro",
    gdp: "macro", employment: "macro", bond_market: "macro",
    trade_policy: "policy", trade_policy_tariff: "policy", geopolitics: "policy",
    broad_market: "markets", markets: "markets",
    crypto: "crypto",
    earnings: "earnings",
  };
  if (topicCategoryMap[topicKey]) return topicCategoryMap[topicKey];

  // 2. Content-based inference from the actual synthesized text
  const lower = `${title} ${story}`.toLowerCase();
  const scores: Record<string, number> = { macro: 0, earnings: 0, markets: 0, policy: 0, crypto: 0 };

  // Macro signals
  if (/\b(?:fed(?:eral)?|fomc|interest\s+rate|inflation|cpi|gdp|treasury|yield|monetary\s+policy)\b/.test(lower)) scores.macro += 3;
  if (/\b(?:economic|economy|recession|unemployment|labor\s+market|rate\s+cut|rate\s+hike)\b/.test(lower)) scores.macro += 2;

  // Earnings signals
  if (/\b(?:earnings|quarterly\s+results?|revenue|eps|profit|guidance|fiscal\s+quarter|analyst.{0,10}target)\b/.test(lower)) scores.earnings += 3;
  if (/\b(?:price\s+target|downgrade|upgrade|overweight|underweight|outperform|buy\s+rat(?:e|ing))\b/.test(lower)) scores.earnings += 2;

  // Markets signals
  if (/\b(?:s&p\s+500|nasdaq|dow\s+jones|stock\s+market|equities|market\s+rally|selloff|sell-off)\b/.test(lower)) scores.markets += 3;
  if (/\b(?:sector\s+rotation|valuation|multiple|bull|bear|correction)\b/.test(lower)) scores.markets += 2;

  // Policy signals
  if (/\b(?:tariff|sanction|regulat|legislation|bill|congress|sec\s|ftc|antitrust|geopolit)\b/.test(lower)) scores.policy += 3;

  // Crypto signals
  if (/\b(?:bitcoin|crypto|ethereum|blockchain|defi|stablecoin|altcoin|btc)\b/.test(lower)) scores.crypto += 3;

  let best: "macro" | "earnings" | "markets" | "policy" | "crypto" | "other" = "other";
  let bestScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = cat as typeof best;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : "other";
}

function inferSentiment(text: string): "positive" | "negative" | "neutral" {
  const lower = text.toLowerCase();

  // Context-aware patterns: match phrases not just isolated words
  // This prevents "record losses" from being counted as positive
  const positivePatterns = [
    /\b(?:strong|robust|solid)\s+(?:growth|earnings|revenue|results|performance)\b/,
    /\b(?:beat|surpass|exceed|top)(?:s|ed|ing)?\s+(?:expectations?|estimates?|consensus|forecast)\b/,
    /\brall(?:y|ied|ies|ying)\b/,
    /\b(?:gains?|surge[ds]?|climb[sed]*|advance[ds]?|soar[sed]*)\b/,
    /\brecord\s+(?:high|revenue|profit|earnings|growth)\b/,
    /\b(?:upgrade[ds]?|raise[ds]?\s+(?:price\s+)?target)\b/,
    /\b(?:bullish|optimis(?:m|tic)|upside|outperform)\b/,
    /\bacceler(?:at(?:e[ds]?|ing|ion))\b/,
  ];
  const negativePatterns = [
    /\b(?:cut[s]?\s+(?:price\s+)?target|downgrade[ds]?|lower[sed]*\s+(?:price\s+)?target)\b/,
    /\b(?:decline[ds]?|fall[s]?|fell|drop(?:s|ped)?|slump[sed]*|plunge[ds]?|tumble[ds]?)\b/,
    /\b(?:loss|losses)\b/,
    /\b(?:weak(?:ness|ening|er)?|deteriorat(?:e[ds]?|ing|ion)|compress(?:es|ed|ing|ion)?)\b/,
    /\b(?:recession|contraction|slowdown|decelerat(?:e[ds]?|ing|ion))\b/,
    /\b(?:miss(?:es|ed)?)\s+(?:expectations?|estimates?|consensus|forecast)\b/,
    /\b(?:bearish|pessimis(?:m|tic)|downside|underperform|headwind[s]?)\b/,
    /\b(?:pressure[ds]?|risk[s]?|threat[s]?|concern[s]?|warning[s]?)\b/,
    /\brecord\s+(?:low|loss|decline|drop)\b/,
  ];

  const posCount = positivePatterns.filter((p) => p.test(lower)).length;
  const negCount = negativePatterns.filter((p) => p.test(lower)).length;

  // Require meaningful margin to avoid noise
  if (posCount >= negCount + 2) return "positive";
  if (negCount >= posCount + 2) return "negative";
  if (posCount > negCount) return "positive";
  if (negCount > posCount) return "negative";
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

/** Well-known company/ticker patterns to extract from article text */
const TICKER_PATTERNS: [RegExp, string][] = [
  [/\b(?:apple|aapl)\b/i, "AAPL"], [/\b(?:nvidia|nvda)\b/i, "NVDA"],
  [/\b(?:microsoft|msft)\b/i, "MSFT"], [/\b(?:amazon|amzn)\b/i, "AMZN"],
  [/\b(?:alphabet|googl|google)\b/i, "GOOGL"], [/\b(?:meta platforms|meta )\b/i, "META"],
  [/\b(?:tesla|tsla)\b/i, "TSLA"], [/\b(?:jpmorgan|jpm)\b/i, "JPM"],
  [/\b(?:goldman sachs)\b/i, "GS"], [/\b(?:morgan stanley)\b/i, "MS"],
  [/\b(?:bank of america|bofa)\b/i, "BAC"], [/\b(?:wells fargo)\b/i, "WFC"],
  [/\b(?:berkshire hathaway|berkshire)\b/i, "BRK.B"],
  [/\b(?:unitedhealth|unh)\b/i, "UNH"], [/\bhumana\b/i, "HUM"],
  [/\b(?:pfizer|pfe)\b/i, "PFE"], [/\b(?:eli lilly|lly)\b/i, "LLY"],
  [/\b(?:johnson & johnson|j&j)\b/i, "JNJ"],
  [/\b(?:boeing)\b/i, "BA"], [/\b(?:exxon|exxonmobil)\b/i, "XOM"],
  [/\b(?:chevron|cvx)\b/i, "CVX"], [/\bprudential\b/i, "PRU"],
  [/\b(?:first solar)\b/i, "FSLR"], [/\b(?:nextracker)\b/i, "NXT"],
  [/\b(?:walmart|wmt)\b/i, "WMT"], [/\b(?:costco)\b/i, "COST"],
  [/\b(?:netflix|nflx)\b/i, "NFLX"], [/\b(?:disney|dis)\b/i, "DIS"],
  [/\b(?:salesforce|crm)\b/i, "CRM"], [/\b(?:palantir|pltr)\b/i, "PLTR"],
  [/\b(?:amd|advanced micro)\b/i, "AMD"], [/\b(?:intel|intc)\b/i, "INTC"],
  [/\bepam\b/i, "EPAM"], [/\b(?:sprouts farmers)\b/i, "SFM"],
];

/**
 * Generate 2–3 validated tags from controlled taxonomy.
 * Now also scans synthesized text for company tickers mentioned in the article.
 */
function generateTags(
  topicKey: string,
  synthesizedText: string,
  category: string
): string[] {
  const topicNorm = topicKey.toLowerCase().replace(/\s+/g, "_");
  const topicTags = TOPIC_TAGS[topicNorm] ?? [];
  const catTags = CATEGORY_TAGS[category] ?? ["MACRO"];

  // 1. Scan for known asset identifiers
  const knownAssets = ["WTI", "CRUDE", "GOLD", "SPX", "DXY", "BTC", "ETH", "VIX"];
  const assetRegex = new RegExp(`\\b(${knownAssets.join("|")})\\b`, "g");
  const textAssets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = assetRegex.exec(synthesizedText)) !== null) {
    textAssets.push(m[1]);
  }

  // 2. Scan for company tickers mentioned in the synthesized text
  const mentionedTickers: string[] = [];
  for (const [pattern, ticker] of TICKER_PATTERNS) {
    if (pattern.test(synthesizedText)) {
      mentionedTickers.push(ticker);
    }
  }

  // 3. Combine: company tickers first (most specific), then topic tags, then assets, then category
  // If we found company tickers, prefer those over generic taxonomy tags
  if (mentionedTickers.length > 0) {
    return [...new Set(mentionedTickers)].slice(0, 3);
  }

  const combined = [...new Set([...topicTags, ...textAssets, ...catTags])];
  const valid = combined.filter((t) => ALLOWED_TAGS.has(t));
  return valid.slice(0, 3);
}

function generateId(topic: string): string {
  const hash = topic.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `news-${Date.now()}-${hash}`;
}
