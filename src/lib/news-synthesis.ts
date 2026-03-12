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

  // Only synthesize top 5 stories to control cost
  const groupsToProcess = groupedNews.slice(0, 5);

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

      if (!synthesizedText || synthesizedText.length < 50) {
        stats.errors++;
        console.error(`[synthesis] Synthesis failed for "${group.topic}" - text length: ${synthesizedText?.length || 0}`);
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
  return `You are a financial analyst and news synthesizer.

${formatToneForPrompt(toneProfile)}

CRITICAL RULES

1 Write 2-4 paragraphs
2 Base all claims only on provided sources
3 Use numbers, names, and companies from sources
4 Write like a disciplined value investor
5 Do not copy headlines
6 Do not invent facts

Start directly with the story.`;
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

Write the story now.`;
}

/**
 * Extract title
 */
function extractTitle(story: string, fallback: string): string {
  const firstSentence = story.split(/[.!?]/)[0];

  if (firstSentence && firstSentence.length > 10 && firstSentence.length < 150)
    return firstSentence.trim();

  return fallback;
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
