import Anthropic from "@anthropic-ai/sdk";
import { GroupedNews, NewsItem, KeyDataPoint, ChartDataset } from "./news-types";
import { analyzeTone, formatToneForPrompt, ToneProfile } from "./tone-analyzer";
import {
  extractClaimsFromStory,
  verifyClaims,
  scoreFactCheckResult,
  shouldRejectStory,
  logRejection,
} from "./fact-checker";
import { formatNewsForStorage } from "./news";
import { fetchContextualData, buildNewsChartData } from "./market-data";

let anthropic: Anthropic | null = null;
let cachedToneProfile: ToneProfile | null = null;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Photo constants — curated Unsplash queries per topic key
// ---------------------------------------------------------------------------

const TOPIC_IMAGE_QUERIES: Record<string, string> = {
  federal_reserve: "federal reserve washington building architecture",
  inflation: "economy money price grocery inflation",
  gdp: "economy growth city skyline aerial",
  employment: "office workers employment jobs economy",
  trade_policy: "shipping containers port cargo trade",
  broad_market: "stock market wall street new york",
  crypto: "bitcoin cryptocurrency digital blockchain",
  bankruptcy: "financial crisis empty office building",
  merger_acquisition: "business handshake meeting office deal",
  bond_market: "treasury bonds government finance yield",
  energy: "oil refinery pipeline sunset energy",
  earnings: "financial charts graphs trading screen",
  fed_macro: "federal reserve monetary policy economy",
};

const DEFAULT_IMAGE_QUERY = "financial markets stock chart data";

// Hardcoded fallback URLs — work with no API key (guaranteed photo in dev + production)
const FALLBACK_IMAGE_MAP: Record<string, string> = {
  // Topic-level
  federal_reserve:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  fed_macro:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  inflation:
    "https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?w=1200&q=80",
  gdp:
    "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1200&q=80",
  employment:
    "https://images.unsplash.com/photo-1521737711867-e3b97375f902?w=1200&q=80",
  trade_policy:
    "https://images.unsplash.com/photo-1494412574643-ff11b0a5c1c3?w=1200&q=80",
  broad_market:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  crypto:
    "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80",
  bankruptcy:
    "https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=1200&q=80",
  merger_acquisition:
    "https://images.unsplash.com/photo-1521791136064-7986c2920216?w=1200&q=80",
  bond_market:
    "https://images.unsplash.com/photo-1569025591598-35bcd6438bda?w=1200&q=80",
  energy:
    "https://images.unsplash.com/photo-1466611653911-95081537e5b7?w=1200&q=80",
  earnings:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  // Category-level fallbacks
  macro:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  markets:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  policy:
    "https://images.unsplash.com/photo-1569025591598-35bcd6438bda?w=1200&q=80",
  other:
    "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
};

// Category-specific angles for story uniqueness
const CATEGORY_ANGLES: Record<string, string> = {
  macro: "Explore what this means for rate-sensitive sectors or the yield curve.",
  earnings:
    "Focus on the gap between guidance and actual results, or the forward-looking signals in management commentary.",
  markets:
    "Identify the sector rotation or market breadth implications beneath the index-level move.",
  policy:
    "Examine who bears the regulatory or fiscal burden and who benefits.",
  crypto:
    "Weigh institutional adoption signals against on-chain fundamentals or macro headwinds.",
  other:
    "Find the second-order market implication beyond the headline event.",
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
}

/**
 * Parse the structured Claude output format into discrete fields.
 *
 * Expected format:
 *   HEADLINE: [headline]
 *   WHY_MATTERS: [one sentence]
 *   SECOND_ORDER: [one sentence]
 *   WHAT_WATCH: [one sentence]
 *
 *   [story paragraphs]
 */
function parseStructuredOutput(raw: string, fallbackTitle: string): ParsedArticle {
  const lines = raw.split("\n");
  const result: ParsedArticle = {
    title: fallbackTitle,
    story: "",
    whyThisMatters: "",
    whatToWatchNext: "",
    secondOrderImplication: "",
  };

  const storyLines: string[] = [];
  let inStory = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("HEADLINE:")) {
      result.title = trimmed.replace("HEADLINE:", "").trim();
    } else if (trimmed.startsWith("WHY_MATTERS:")) {
      result.whyThisMatters = trimmed.replace("WHY_MATTERS:", "").trim();
    } else if (trimmed.startsWith("SECOND_ORDER:")) {
      result.secondOrderImplication = trimmed.replace("SECOND_ORDER:", "").trim();
    } else if (trimmed.startsWith("WHAT_WATCH:")) {
      result.whatToWatchNext = trimmed.replace("WHAT_WATCH:", "").trim();
    } else if (trimmed === "" && !inStory && result.title !== fallbackTitle) {
      // Blank line after header section signals story start
      inStory = true;
    } else if (inStory || (!trimmed.startsWith("HEADLINE:") && !trimmed.startsWith("WHY_MATTERS:") && !trimmed.startsWith("SECOND_ORDER:") && !trimmed.startsWith("WHAT_WATCH:"))) {
      if (trimmed.length > 0) {
        storyLines.push(trimmed);
        inStory = true;
      }
    }
  }

  result.story = storyLines.join("\n\n");

  // Fallbacks if parsing missed sections
  if (!result.title || result.title.length < 5) {
    const firstSentence = raw.split(/[.!?]/)[0].trim();
    result.title = firstSentence.length > 10 && firstSentence.length < 150
      ? firstSentence
      : fallbackTitle;
  }

  if (!result.story || result.story.length < 100) {
    // Use raw text minus any header lines
    const bodyLines = lines.filter(
      (l) => !l.startsWith("HEADLINE:") && !l.startsWith("WHY_MATTERS:") &&
              !l.startsWith("SECOND_ORDER:") && !l.startsWith("WHAT_WATCH:")
    );
    result.story = bodyLines.join("\n").trim();
  }

  return result;
}

// ---------------------------------------------------------------------------
// System Prompt — evidence-grounded journalism
// ---------------------------------------------------------------------------

function createSystemPrompt(toneProfile: ToneProfile): string {
  return `You are a financial journalist writing for Market Mountain, an independent equity research publication.

${formatToneForPrompt(toneProfile)}

Write in the style of The Wall Street Journal or Financial Times — clear, authoritative, analytical, and precise.

STRUCTURE
Output your response in this exact format — no deviations:

HEADLINE: [sharp, specific news headline, 8–12 words, no dashes]
WHY_MATTERS: [one sentence explaining why this story matters to investors]
SECOND_ORDER: [one sentence identifying the second-order market implication beyond the headline]
WHAT_WATCH: [one sentence on the most important forward-looking signal to monitor]

[blank line]
[story body — 3 paragraphs]

STORY RULES

1 Open with the single most important fact — inverted pyramid, most newsworthy detail first
2 Paragraph 1 (Lede): Key event with the most impactful number or consequence
3 Paragraph 2 (Context): Background that explains why this happened and what preceded it
4 Paragraph 3 (Analysis + Market Impact): What this means for markets, sectors, or investors
5 Use specific numbers, company names, dates, and percentage figures from the sources
6 Include at least two numerical data points in the story body
7 Synthesize — do not repeat the same fact in multiple paragraphs
8 Write with analytical depth and measured tone — not sensationalism
9 Do not invent any facts not present in the provided sources
10 No markdown formatting — no headers, bullet points, bold, italic, or horizontal rules
11 No dashes of any kind (em dash or hyphen used as punctuation)
12 Write in third person only — never use "I" or first-person perspective
13 Write in plain prose paragraphs only

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

Write for a financially literate reader who values accuracy, analysis, and forward-looking insight over hype.`;
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
      ? `\nRELEVANT MARKET DATA (verified — use these numbers when writing the analysis paragraph):\n` +
        contextualData
          .map((d) => `  ${d.label}: ${d.value}${d.change ? ` (${d.change})` : ""}${d.source ? ` — ${d.source}` : ""}`)
          .join("\n")
      : "";

  return `Write one cohesive financial news story about "${group.topic}"

SOURCES (use all of them — synthesize, do not summarize):
${articleTexts}
${dataContext}

Editorial angle: ${angle}

Remember to output HEADLINE, WHY_MATTERS, SECOND_ORDER, WHAT_WATCH headers first, then one blank line, then the 3-paragraph story.`;
}

// ---------------------------------------------------------------------------
// MAIN SYNTHESIS FUNCTION
// ---------------------------------------------------------------------------

export async function synthesizeGroupedArticles(
  groupedNews: GroupedNews[]
): Promise<{
  stories: NewsItem[];
  stats: { posted: number; rejected: number; errors: number };
}> {
  const stories: NewsItem[] = [];
  const stats = { posted: 0, rejected: 0, errors: 0 };

  const toneProfile = await getToneProfile();
  const client = initAnthropicClient();

  // Per-run image cache — avoid duplicate Unsplash API calls for same topic
  const runImageCache = new Map<string, string>();

  // Track chart budget — limit to 2 chart-enriched stories per batch to avoid API overload
  let chartCount = 0;
  const MAX_CHARTS_PER_RUN = 2;

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

  for (const group of groupsToProcess) {
    try {
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

      const synthesizedText = await callClaude(client, systemPrompt, userPrompt, 1200);

      if (!synthesizedText || synthesizedText.length < 200) {
        stats.errors++;
        console.error(
          `[synthesis] Output too short for "${group.topic}" — length: ${synthesizedText?.length ?? 0}`
        );
        continue;
      }

      console.log(`[synthesis] Generated ${synthesizedText.length} chars for "${group.topic}"`);

      // Fact-check
      const claims = extractClaimsFromStory(synthesizedText);
      const { overallScore } = await verifyClaims(claims);
      scoreFactCheckResult([]);

      if (shouldRejectStory(overallScore, 0)) {
        stats.rejected++;
        console.warn(`[synthesis] Rejected "${group.topic}" — fact-check score ${overallScore}`);
        logRejection(group.topic, `Fact check score: ${overallScore}`, overallScore);
        continue;
      }

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

      // Image resolution: Unsplash → topic fallback → category fallback → undefined
      const unsplashUrl = await fetchUnsplashImage(group.topic, runImageCache);
      const imageUrl =
        unsplashUrl ??
        FALLBACK_IMAGE_MAP[group.topic] ??
        FALLBACK_IMAGE_MAP[group.category] ??
        undefined;

      // Optional chart data — only for macro/FRED-backed topics, capped at MAX_CHARTS_PER_RUN
      let chartData: ChartDataset | undefined;
      if (chartCount < MAX_CHARTS_PER_RUN) {
        chartData = await buildChartData(group.topic, group.category);
        if (chartData) chartCount++;
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
        relatedTickers: extractTickers(synthesizedText),
        sourcesUsed: group.articles.map((article) => {
          const fmt = formatNewsForStorage([article])[0];
          return { title: fmt.title, url: fmt.url, source: fmt.source };
        }),
        synthesizedBy: "Claude",
        factCheckScore: overallScore,
        verifiedClaims: claims.slice(0, 3),
        toneMatch: "Trevor's voice - analytical, data-driven, measured skepticism",
        // Editorial enrichment
        whyThisMatters: parsed.whyThisMatters || undefined,
        whatToWatchNext: parsed.whatToWatchNext || undefined,
        secondOrderImplication: parsed.secondOrderImplication || undefined,
        keyDataPoints: contextualData.length > 0 ? contextualData : undefined,
        chartData,
      };

      stories.push(newsItem);
      stats.posted++;

      console.log(
        `[synthesis] ✓ "${parsed.title}" — whyMatters=${!!parsed.whyThisMatters}, keyData=${contextualData.length}, chart=${!!chartData}`
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

  console.log(
    `[synthesis] Done: processed=${groupsToProcess.length}, posted=${stats.posted}, rejected=${stats.rejected}, errors=${stats.errors}`
  );

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
async function buildChartData(
  topicKey: string,
  _category: string
): Promise<ChartDataset | undefined> {
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

function extractTickers(text: string): string[] {
  const tickers = new Set<string>();
  const regex = /\$?([A-Z]{2,5})(?:\s|$|[,.])/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tickers.add(match[1]);
  }
  return Array.from(tickers).slice(0, 5);
}

function generateId(topic: string): string {
  const hash = topic.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `news-${Date.now()}-${hash}`;
}
