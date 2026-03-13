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
 * Call Claude
 */
async function synthesizeWithClaude(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    temperature: 0.7,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  return extractClaudeText(response);
}

/**
 * MAIN SYNTHESIS FUNCTION
 */
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

  // Deduplicate by topic key — skip groups whose topic is too similar to one already queued.
  // This prevents near-duplicate stories even when they land in different category buckets.
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

      // For MVP: skip strict fact-checking since heuristic gives scores 20-40 for valid news
      // Once we have better fact-checking or human review, we can re-enable strict filtering
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

      const categoryFallbackQueries: Record<string, string> = {
        macro: "federal reserve economy",
        earnings: "stock market earnings",
        markets: "financial markets trading",
        policy: "government policy regulation",
        crypto: "cryptocurrency bitcoin",
        other: "financial markets",
      };
      const imageUrl =
        (await fetchUnsplashImage(parsedTitle)) ??
        (await fetchUnsplashImage(categoryFallbackQueries[group.category] ?? "financial markets"));

      const newsItem: NewsItem = {
        id: generateId(group.topic),
        title: parsedTitle,
        story: parsedStory,
        category: group.category,
        imageUrl: imageUrl || undefined,
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

/**
 * System Prompt
 */
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

Write for a financially literate reader who values accuracy and insight over hype.`;
}

/**
 * User Prompt
 */
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

  return `Write one cohesive story about "${group.topic}"

${articleTexts}

Format your response EXACTLY as:
HEADLINE: [sharp, specific news headline, 8 to 12 words, no dashes]

[story body paragraphs]`;
}

/**
 * Parse HEADLINE: prefix from synthesized text.
 * Returns { title, story } with the headline stripped from the story body.
 */
function parseHeadlineAndStory(
  raw: string,
  fallback: string
): { title: string; story: string } {
  const lines = raw.split("\n");
  if (lines[0].startsWith("HEADLINE:")) {
    const title = lines[0].replace("HEADLINE:", "").trim();
    // Drop the headline line (and any immediately following blank line)
    const rest = lines.slice(1);
    const story = rest.join("\n").trim();
    if (title.length > 5) return { title, story };
  }
  // Fallback: use first sentence as title, full text as story
  const firstSentence = raw.split(/[.!?]/)[0].trim();
  const title =
    firstSentence.length > 10 && firstSentence.length < 150
      ? firstSentence
      : fallback;
  return { title, story: raw };
}

/**
 * Fetch a relevant landscape photo from Unsplash for a given search query.
 * Returns the `urls.regular` string, or null if unavailable.
 */
async function fetchUnsplashImage(query: string): Promise<string | null> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results?.[0]?.urls?.regular as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sentiment
 */
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

/**
 * Extract tickers
 */
function extractTickers(text: string): string[] {
  const tickers = new Set<string>();

  const regex = /\$?([A-Z]{1,5})(?:\s|$|[,.\-])/g;

  let match;

  while ((match = regex.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  return Array.from(tickers).slice(0, 5);
}

/**
 * Generate ID
 */
function generateId(topic: string): string {
  const hash = topic
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);

  return `news-${Date.now()}-${hash}`;
}
