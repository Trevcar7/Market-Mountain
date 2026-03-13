import Anthropic from "@anthropic-ai/sdk";
import { GroupedNews, NewsItem } from "./news-types";
import { analyzeTone, formatToneForPrompt, ToneProfile } from "./tone-analyzer";
import {
  extractClaimsFromStory,
  verifyClaims,
  scoreFactCheckResult,
  shouldRejectStory,
  logRejection,
} from "./fact-checker";
import { formatNewsForStorage } from "./news";

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

// Category-specific angles injected into the user prompt for story uniqueness
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

/**
 * Initialize Claude client
 */
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

/**
 * Get cached tone profile
 */
async function getToneProfile(): Promise<ToneProfile> {
  if (!cachedToneProfile) {
    cachedToneProfile = await analyzeTone();
  }

  return cachedToneProfile;
}

/**
 * Extract text from Claude response safely
 */
function extractClaudeText(response: any): string {
  let text = "";

  if (!response?.content) return text;

  for (const block of response.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text + "\n";
    }
  }

  return text.trim();
}

/**
 * Call Claude with a per-call timeout to prevent hung requests
 */
async function synthesizeWithClaude(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s per call

  try {
    const response = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        temperature: 0.75,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      },
      { signal: controller.signal as any }
    );

    return extractClaudeText(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// MAIN SYNTHESIS FUNCTION
// ---------------------------------------------------------------------------

export async function synthesizeGroupedArticles(
  groupedNews: GroupedNews[]
): Promise<{
  stories: NewsItem[];
  stats: {
    posted: number;
    rejected: number;
    errors: number;
  };
}> {
  const stories: NewsItem[] = [];

  const stats = {
    posted: 0,
    rejected: 0,
    errors: 0,
  };

  const toneProfile = await getToneProfile();
  const client = initAnthropicClient();

  // In-run image cache — avoid duplicate Unsplash API calls for same topic
  const runImageCache = new Map<string, string>();

  // Deduplicate by topic key — skip groups whose topic is too similar to one already queued.
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

      console.log(`[synthesis] Processing group: "${group.topic}" (${group.articles.length} articles, importance=${group.importance})`);

      const systemPrompt = createSystemPrompt(toneProfile);
      const userPrompt = createUserPrompt(group, formattedArticles);

      const synthesizedText = await synthesizeWithClaude(
        client,
        systemPrompt,
        userPrompt
      );

      if (!synthesizedText || synthesizedText.length < 200) {
        stats.errors++;
        console.error(`[synthesis] Synthesis too short for "${group.topic}" - text length: ${synthesizedText?.length || 0}`);
        continue;
      }

      console.log(`[synthesis] Generated ${synthesizedText.length} chars for "${group.topic}"`);

      const claims = extractClaimsFromStory(synthesizedText);

      const { overallScore } = await verifyClaims(claims);

      scoreFactCheckResult([]);

      console.log(`[synthesis] Fact-check score for "${group.topic}": ${overallScore}`);

      if (shouldRejectStory(overallScore, 0)) {
        stats.rejected++;

        console.warn(`[synthesis] Story rejected: "${group.topic}" - fact-check score ${overallScore} < 0 threshold`);

        logRejection(
          group.topic,
          `Fact check score too low: ${overallScore}`,
          overallScore
        );

        continue;
      }

      const { title: parsedTitle, story: parsedStory } = parseHeadlineAndStory(
        synthesizedText,
        group.topic
      );

      // Three-tier image resolution:
      // 1. Unsplash API with curated topic query (production, requires API key)
      // 2. Hardcoded fallback URL per topic/category (always works, no API key needed)
      // 3. undefined → gradient fallback in NewsCard (last resort)
      const unsplashUrl = await fetchUnsplashImage(group.topic, runImageCache);
      const imageUrl =
        unsplashUrl ??
        FALLBACK_IMAGE_MAP[group.topic] ??
        FALLBACK_IMAGE_MAP[group.category] ??
        undefined;

      const newsItem: NewsItem = {
        id: generateId(group.topic),
        title: parsedTitle,
        story: parsedStory,
        category: group.category,
        topicKey: group.topic,
        imageUrl,
        publishedAt: new Date().toISOString(),
        importance: group.importance,
        sentiment: inferSentiment(synthesizedText),
        relatedTickers: extractTickers(synthesizedText),
        sourcesUsed: group.articles.map((article) => {
          const formatted = formatNewsForStorage([article])[0];

          return {
            title: formatted.title,
            url: formatted.url,
            source: formatted.source,
          };
        }),
        synthesizedBy: "Claude",
        factCheckScore: overallScore,
        verifiedClaims: claims.slice(0, 3),
        toneMatch:
          "Trevor's voice - analytical, data-driven, measured skepticism",
      };

      stories.push(newsItem);

      stats.posted++;

      console.log(`[synthesis] ✓ Story posted for "${group.topic}" (${newsItem.relatedTickers?.join(", ") || "no tickers"})`);

      await sleep(2000);
    } catch (error) {
      stats.errors++;

      console.error(`[synthesis] Exception synthesizing "${group.topic}":`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`[synthesis] Summary: processed=${groupsToProcess.length}, posted=${stats.posted}, rejected=${stats.rejected}, errors=${stats.errors}`);

  return { stories, stats };
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

function createSystemPrompt(toneProfile: ToneProfile): string {
  return `You are a financial journalist writing for Market Mountain, an independent equity research publication.

${formatToneForPrompt(toneProfile)}

Write in the style of The Wall Street Journal or Financial Times — clear, authoritative, and precise.

RULES

1 Open with the single most important fact (inverted pyramid — most newsworthy detail first)
2 Write 2–4 tight paragraphs: lede, context, analysis, market implications
3 Use specific numbers, company names, dates, and figures from the sources
4 Synthesize the information — do not repeat the same fact across multiple paragraphs
5 Write with analytical depth and measured tone, not sensationalism
6 Do not invent any facts not present in the provided sources
7 Do NOT use any markdown formatting: no headers (#), no bullet points, no bold/italic markers, no horizontal rules
8 Do NOT use dashes (em dash or hyphen) in your writing
9 Write in third person only. Never use "I" or first-person perspective
10 Write in plain prose paragraphs only

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

Write for a financially literate reader who values accuracy and insight over hype.`;
}

// ---------------------------------------------------------------------------
// User Prompt
// ---------------------------------------------------------------------------

function createUserPrompt(
  group: GroupedNews,
  formattedArticles: any[]
): string {
  const articleTexts = formattedArticles
    .map(
      (article: any, i: number) =>
        `SOURCE ${i + 1}
Title: ${article.title}
Summary: ${article.summary}`
    )
    .join("\n\n");

  const angle = CATEGORY_ANGLES[group.category] ?? CATEGORY_ANGLES.other;

  return `Write one cohesive story about "${group.topic}"

${articleTexts}

Angle to explore: ${angle}

Format your response EXACTLY as:
HEADLINE: [sharp, specific news headline, 8 to 12 words, no dashes]

[story body paragraphs]`;
}

// ---------------------------------------------------------------------------
// Parse HEADLINE prefix
// ---------------------------------------------------------------------------

function parseHeadlineAndStory(
  raw: string,
  fallback: string
): { title: string; story: string } {
  const lines = raw.split("\n");
  if (lines[0].startsWith("HEADLINE:")) {
    const title = lines[0].replace("HEADLINE:", "").trim();
    const rest = lines.slice(1);
    const story = rest.join("\n").trim();
    if (title.length > 5) return { title, story };
  }
  const firstSentence = raw.split(/[.!?]/)[0].trim();
  const title =
    firstSentence.length > 10 && firstSentence.length < 150
      ? firstSentence
      : fallback;
  return { title, story: raw };
}

// ---------------------------------------------------------------------------
// Three-tier Unsplash image resolver
// ---------------------------------------------------------------------------

/**
 * Fetch a landscape photo from Unsplash using a curated topic-key query.
 * Returns normalized `?w=1200&q=80` URL, or null if unavailable.
 * Uses a per-run cache to avoid duplicate API calls for the same topic.
 */
async function fetchUnsplashImage(
  topicKey: string,
  cache: Map<string, string>
): Promise<string | null> {
  const apiKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!apiKey) return null;

  // Check in-run cache first
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

    if (!res.ok) {
      console.warn(`[unsplash] API returned ${res.status} for topic "${topicKey}"`);
      return null;
    }

    const data = await res.json();
    const photoUrl = (data.results?.[0]?.urls?.regular as string) ?? null;
    if (!photoUrl) return null;

    // Normalize to w=1200 — strip any existing query params from Unsplash CDN URL
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

  const positive = ["growth", "gain", "rise", "strength", "rally"];
  const negative = ["fall", "decline", "loss", "risk", "weakness"];

  const pos = positive.filter((w) => lower.includes(w)).length;
  const neg = negative.filter((w) => lower.includes(w)).length;

  if (pos > neg) return "positive";
  if (neg > pos) return "negative";

  return "neutral";
}

function extractTickers(text: string): string[] {
  const tickers = new Set<string>();

  const regex = /\$?([A-Z]{1,5})(?:\s|$|[,.\-])/g;

  let match;

  while ((match = regex.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  return Array.from(tickers).slice(0, 5);
}

function generateId(topic: string): string {
  const hash = topic
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);

  return `news-${Date.now()}-${hash}`;
}
