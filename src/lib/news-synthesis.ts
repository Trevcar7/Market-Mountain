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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initialize Anthropic client
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
 * Get cached tone profile or analyze articles
 */
async function getToneProfile(): Promise<ToneProfile> {
  if (!cachedToneProfile) {
    cachedToneProfile = await analyzeTone();
  }
  return cachedToneProfile;
}

/**
 * Basic quality filter so we do not waste model calls on junk topics
 */
function isWeakTopic(topic: string): boolean {
  const t = topic.trim().toLowerCase();
  if (t.length < 12) return true;

  const weak = new Set([
    "fed",
    "rate",
    "rates",
    "earnings",
    "inflation",
    "markets",
    "stocks",
    "crypto",
  ]);

  return weak.has(t);
}

/**
 * Call Claude with one retry for transient failures
 */
async function synthesizeWithClaude(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        temperature: 0.7,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      });

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (!text) {
        throw new Error("empty response");
      }

      return text;
    } catch (error: any) {
      const isLastAttempt = attempt === maxAttempts;
      const status = error?.status;

      if (isLastAttempt || (status !== 429 && status !== 500 && status !== 502 && status !== 503 && status !== 504)) {
        throw error;
      }

      const retryDelayMs = 8000 * attempt;
      console.warn(`Claude call failed (attempt ${attempt}). Retrying in ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
    }
  }

  throw new Error("Failed to synthesize after retries");
}

/**
 * Main synthesis function: group articles and synthesize into original stories
 */
export async function synthesizeGroupedArticles(
  groupedNews: GroupedNews[]
): Promise<{
  stories: NewsItem[];
  stats: {
    posted: number;
    rejected: number;
    errors: number;
    skipped: number;
    retried: number;
  };
}> {
  const stories: NewsItem[] = [];
  const stats = {
    posted: 0,
    rejected: 0,
    errors: 0,
    skipped: 0,
    retried: 0,
  };

  const toneProfile = await getToneProfile();
  const client = initAnthropicClient();

  const rankedGroups = [...groupedNews]
    .filter((group) => !isWeakTopic(group.topic))
    .sort((a, b) => {
      const importanceDiff = (b.importance ?? 0) - (a.importance ?? 0);
      if (importanceDiff !== 0) return importanceDiff;
      return (b.articles?.length ?? 0) - (a.articles?.length ?? 0);
    })
    .slice(0, 5);

  stats.skipped = Math.max(0, groupedNews.length - rankedGroups.length);

  for (const [index, group] of rankedGroups.entries()) {
    try {
      const formattedArticles = formatNewsForStorage(group.articles);

      const systemPrompt = createSystemPrompt(toneProfile);
      const userPrompt = createUserPrompt(group, formattedArticles);

      const synthesizedText = await synthesizeWithClaude(
        client,
        systemPrompt,
        userPrompt
      );

      if (!synthesizedText || synthesizedText.length < 50) {
        stats.errors++;
        console.error(`Synthesis failed for "${group.topic}": empty response`);
        continue;
      }

      const claims = extractClaimsFromStory(synthesizedText);
      const { overallScore } = await verifyClaims(claims);
      scoreFactCheckResult([]);

      if (shouldRejectStory(overallScore, 75)) {
        stats.rejected++;
        logRejection(
          group.topic,
          `Fact-check score too low: ${overallScore}`,
          overallScore
        );
        continue;
      }

      const newsItem: NewsItem = {
        id: generateId(group.topic),
        title: extractTitle(synthesizedText, group.topic),
        story: synthesizedText,
        category: group.category,
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
        synthesizedBy: "Claude Haiku 4.5",
        factCheckScore: overallScore,
        verifiedClaims: claims.slice(0, 3),
        toneMatch: "Trevor's voice - analytical, data-driven, measured skepticism",
      };

      stories.push(newsItem);
      stats.posted++;

      if (index < rankedGroups.length - 1) {
        await sleep(2500);
      }
    } catch (error: any) {
      if (error?.status === 429) {
        stats.retried++;
      }
      stats.errors++;
      console.error(`Error synthesizing "${group.topic}":`, error);
    }
  }

  return { stories, stats };
}

/**
 * Create system prompt with tone guidance
 */
function createSystemPrompt(toneProfile: ToneProfile): string {
  return `You are a financial analyst and news synthesizer. Your job is to read multiple news articles about a market event and write an original, cohesive story that synthesizes the information.

${formatToneForPrompt(toneProfile)}

CRITICAL REQUIREMENTS:
1. Write in 2-4 paragraphs (200-400 words)
2. Base EVERY claim on the source articles provided. Do not infer, extrapolate, or add unsupported information
3. Be specific. Reference numbers, names, companies, and dates from sources
4. Use the voice of a disciplined value investor who analyzes fundamentals
5. Acknowledge complexity and risk where appropriate
6. Do NOT copy headlines or sentences verbatim. Synthesize an original narrative
7. If you cannot verify a claim from the sources, do not include it

Start directly with the synthesized story. Do not add disclaimers or warnings.`;
}

/**
 * Create user prompt with article content
 */
function createUserPrompt(
  group: GroupedNews,
  formattedArticles: Array<{
    title: string;
    summary: string;
    url: string;
    source: string;
    publishedAt: string;
  }>
): string {
  const articleTexts = formattedArticles
    .map(
      (article, i) =>
        `SOURCE ${i + 1} (${article.source})
Title: ${article.title}
Summary: ${article.summary}
Published: ${article.publishedAt}
URL: ${article.url}`
    )
    .join("\n\n");

  return `Synthesize the following news articles about "${group.topic}" (Category: ${group.category}) into one original, cohesive story. The story should read naturally and analytically, backed only by facts from these sources.

${articleTexts}

Write the synthesized story now.`;
}

/**
 * Extract title from synthesized story
 */
function extractTitle(story: string, fallback: string): string {
  const firstSentence = story.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length > 10 && firstSentence.length < 150) {
    return firstSentence.trim();
  }
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

/**
 * Infer sentiment from story text
 */
function inferSentiment(
  text: string
): "positive" | "negative" | "neutral" {
  const lowerText = text.toLowerCase();

  const positiveWords = [
    "growth",
    "rise",
    "gain",
    "opportunity",
    "strength",
    "bull",
    "rally",
  ];
  const negativeWords = [
    "decline",
    "fall",
    "loss",
    "risk",
    "weakness",
    "bear",
    "crash",
  ];

  const positiveCount = positiveWords.filter((w) => lowerText.includes(w)).length;
  const negativeCount = negativeWords.filter((w) => lowerText.includes(w)).length;

  if (positiveCount > negativeCount) return "positive";
  if (negativeCount > positiveCount) return "negative";
  return "neutral";
}

/**
 * Extract stock tickers from story text
 */
function extractTickers(text: string): string[] {
  const tickers = new Set<string>();
  const tickerPattern = /\$?([A-Z]{1,5})(?:\s|$|[,.\-])/g;
  let match: RegExpExecArray | null;

  while ((match = tickerPattern.exec(text)) !== null) {
    const ticker = match[1];
    const excluded = ["THE", "AND", "FOR", "WITH", "FROM", "THAT", "THIS"];
    if (!excluded.includes(ticker) && ticker.length >= 1 && ticker.length <= 5) {
      tickers.add(ticker);
    }
  }

  if (text.toLowerCase().includes("s&p 500")) tickers.add("^GSPC");
  if (text.toLowerCase().includes("nasdaq")) tickers.add("^IXIC");
  if (text.toLowerCase().includes("dow")) tickers.add("^DJI");

  return Array.from(tickers).slice(0, 5);
}

/**
 * Generate unique ID for story
 */
function generateId(topic: string): string {
  const hash = topic
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `news-${Date.now()}-${hash}`;
}
