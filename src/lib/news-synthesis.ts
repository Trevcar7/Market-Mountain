import { GoogleGenerativeAI } from "@google/generative-ai";
import { GroupedNews, NewsItem, NewsSource } from "./news-types";
import { analyzeTone, formatToneForPrompt, ToneProfile } from "./tone-analyzer";
import { extractClaimsFromStory, verifyClaims, scoreFactCheckResult, shouldRejectStory, logRejection } from "./fact-checker";
import { formatNewsForStorage } from "./news";

let genAI: GoogleGenerativeAI | null = null;
let cachedToneProfile: ToneProfile | null = null;

/**
 * Initialize Gemini client
 */
export function initGeminiClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
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
  };
}> {
  const stories: NewsItem[] = [];
  const stats = { posted: 0, rejected: 0, errors: 0 };

  const toneProfile = await getToneProfile();
  const client = initGeminiClient();
 const model = client.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  for (const group of groupedNews) {
    try {
      // Convert articles to formatted structure
      const formattedArticles = formatNewsForStorage(group.articles);

      // Create synthesis prompt
      const systemPrompt = createSystemPrompt(toneProfile);
      const userPrompt = createUserPrompt(group, formattedArticles);

      // Call Gemini
      const response = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: systemPrompt + "\n\n" + userPrompt,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.7,
        },
      });

      let synthesizedText = "";
      try {
        const responseData = response as any;
        synthesizedText =
          responseData?.candidates?.[0]?.content?.parts?.[0]?.text ||
          responseData?.text ||
          "";
      } catch {
        // Ignore type errors
      }

      if (!synthesizedText || synthesizedText.length < 50) {
        stats.errors++;
        console.error(`Synthesis failed for "${group.topic}": empty response`);
        continue;
      }

      // Extract and verify claims
      const claims = extractClaimsFromStory(synthesizedText);
      const { overallScore } = await verifyClaims(claims);
      const factCheckScore = scoreFactCheckResult([]);

      // Reject if fact-check fails
      if (shouldRejectStory(overallScore, 75)) {
        stats.rejected++;
        logRejection(
          group.topic,
          `Fact-check score too low: ${overallScore}`,
          overallScore
        );
        continue;
      }

      // Create NewsItem
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
        synthesizedBy: "Gemini",
        factCheckScore: overallScore,
        verifiedClaims: claims.slice(0, 3),
        toneMatch: "Trevor's voice - analytical, data-driven, measured skepticism",
      };

      stories.push(newsItem);
      stats.posted++;
    } catch (error) {
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
2. Base EVERY claim on the source articles provided - do not infer, extrapolate, or add information
3. Be specific: reference numbers, names, companies, dates from sources
4. Use the voice of a disciplined value investor who analyzes fundamentals
5. Acknowledge complexity and risk where appropriate
6. Do NOT copy headlines or sentences verbatim - synthesize original narrative
7. If you cannot verify a claim from the sources, do not include it

Start your response directly with the synthesized story. Do not add disclaimers or warnings.`;
}

/**
 * Create user prompt with article content
 */
function createUserPrompt(
  group: GroupedNews,
  formattedArticles: Array<{ title: string; summary: string; url: string; source: string; publishedAt: string }>
): string {
  const articleTexts = formattedArticles
    .map(
      (article, i) =>
        `SOURCE ${i + 1} (${article.source}):
Title: ${article.title}
Summary: ${article.summary}`
    )
    .join("\n\n");

  return `Synthesize the following news articles about "${group.topic}" (Category: ${group.category}) into one original, cohesive story. The story should read naturally and analytically, backed only by facts from these sources.

${articleTexts}

Write the synthesized story now:`;
}

/**
 * Extract title from synthesized story (first sentence or generated)
 */
function extractTitle(story: string, fallback: string): string {
  const firstSentence = story.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length > 10 && firstSentence.length < 150) {
    return firstSentence.trim();
  }

  // Generate title from topic
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

  const positiveCount = positiveWords.filter((w) => lowerText.includes(w))
    .length;
  const negativeCount = negativeWords.filter((w) => lowerText.includes(w))
    .length;

  if (positiveCount > negativeCount) return "positive";
  if (negativeCount > positiveCount) return "negative";
  return "neutral";
}

/**
 * Extract stock tickers from story text
 */
function extractTickers(text: string): string[] {
  const tickers = new Set<string>();

  // Look for ticker patterns: $AAPL, SPY, ^GSPC, etc.
  const tickerPattern = /\$?([A-Z]{1,5})(?:\s|$|[,.\-])/g;
  let match;

  while ((match = tickerPattern.exec(text)) !== null) {
    const ticker = match[1];
    // Filter out common words that aren't tickers
    const excluded = ["THE", "AND", "FOR", "WITH", "FROM", "THAT", "THIS"];
    if (!excluded.includes(ticker) && ticker.length >= 1 && ticker.length <= 5) {
      tickers.add(ticker);
    }
  }

  // Add known index tickers mentioned
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
