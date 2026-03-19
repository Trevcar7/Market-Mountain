import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection, NewsItem } from "@/lib/news-types";
import { getAnthropicClient, CLAUDE_MODEL } from "@/lib/anthropic-client";

export const maxDuration = 120;
export const runtime = "nodejs";

/**
 * POST /api/admin/improve-articles
 *
 * Claude-powered story rewrites for specific articles.
 * Takes an article ID and a rewrite directive, then uses Claude to
 * refocus the story body while preserving factual content.
 *
 * Body: { articleId: string, directive: string }
 * Or: no body — runs all queued rewrites (see REWRITE_QUEUE below).
 */

interface RewriteDirective {
  directive: string;
  singleThesis?: string; // Optional — the one thesis the article should focus on
}

// Queued rewrites for specific articles
const REWRITE_QUEUE: Record<string, RewriteDirective> = {
  // Apple+IBM M&A: too broad, covers M&A + enterprise + AI + cloud — needs single thesis
  "news-1773770975678-1930": {
    directive: `Rewrite this article to focus on a SINGLE thesis: Apple's strategic pivot into enterprise services through an IBM acquisition.

RULES:
- The central argument: Why Apple acquiring IBM's consulting/enterprise division would be the most significant enterprise tech deal in a decade
- Remove or minimize tangential themes (AI race, cloud computing generalities, stock price speculation)
- Every paragraph must advance the central thesis
- Keep all verified data points and source attributions
- Maintain 5 section headings (## format) but make them specific to the thesis
- Tone: analytical, institutional — like a Goldman Sachs research note
- Length: 6-8 paragraphs total (trim the fat)
- End with a clear "What This Means" paragraph, not speculation`,
    singleThesis: "Apple's enterprise ambitions via IBM acquisition represent a strategic pivot that reshapes the enterprise tech landscape",
  },
};

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  const anthropic = getAnthropicClient();

  // Check for specific article ID in body
  let targetId: string | null = null;
  let customDirective: string | null = null;
  try {
    const body = await req.json();
    targetId = body?.articleId ?? null;
    customDirective = body?.directive ?? null;
  } catch {
    // No body — run all queued rewrites
  }

  try {
    const collection = await kv.get<NewsCollection>("news");
    if (!collection?.news?.length) {
      return NextResponse.json({ message: "No articles", improved: 0 });
    }

    const results: Array<{ id: string; title: string; action: string }> = [];

    for (const article of collection.news) {
      // If targeting a specific article, skip others
      if (targetId && article.id !== targetId) continue;

      const queued = REWRITE_QUEUE[article.id];
      const directive = customDirective ?? queued?.directive;

      if (!directive) continue;

      // Rewrite the story using Claude
      const rewritten = await rewriteStory(anthropic, article, directive);
      if (rewritten) {
        article.story = rewritten;
        article.wordCount = rewritten.trim().split(/\s+/).length;
        results.push({
          id: article.id,
          title: article.title,
          action: `Rewrote story (${article.wordCount} words) — ${queued?.singleThesis ?? "custom directive"}`,
        });
      } else {
        results.push({
          id: article.id,
          title: article.title,
          action: "Rewrite failed — story unchanged",
        });
      }
    }

    // Save
    if (results.some((r) => r.action.startsWith("Rewrote"))) {
      collection.lastUpdated = new Date().toISOString();
      await kv.set("news", collection);
    }

    return NextResponse.json({
      message: `Processed ${results.length} article(s)`,
      results,
    });
  } catch (error) {
    console.error("[improve-articles] Error:", error);
    return NextResponse.json(
      { error: "Failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

async function rewriteStory(
  anthropic: ReturnType<typeof getAnthropicClient>,
  article: NewsItem,
  directive: string
): Promise<string | null> {
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      temperature: 0.4,
      messages: [{
        role: "user",
        content: `You are a senior financial editor at Market Mountain, rewriting an article for publication.

ARTICLE TITLE: "${article.title}"
CATEGORY: ${article.category}
TICKERS: ${(article.relatedTickers ?? []).join(", ")}

CURRENT STORY:
${article.story}

KEY DATA POINTS (preserve these):
${(article.keyDataPoints ?? []).map((d) => `- ${d.label}: ${d.value}${d.change ? ` (${d.change})` : ""}`).join("\n")}

REWRITE DIRECTIVE:
${directive}

FORMATTING RULES:
- Use ## headings to divide sections (exactly 5 sections)
- Separate paragraphs with double newlines
- No bullet points in the story body (use prose)
- No hashtags
- Always write "U.S." (with periods) when referring to the United States
- Do not include MARKET_IMPACT data in the story body

Return ONLY the rewritten story text. No explanation, no markdown code blocks.`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // Basic validation — must have headings and reasonable length
    if (text.includes("## ") && text.split(/\s+/).length > 200) {
      return text.trim();
    }
    console.warn("[improve-articles] Rewrite didn't meet validation:", text.slice(0, 100));
    return null;
  } catch (err) {
    console.error("[improve-articles] Claude rewrite failed:", err);
    return null;
  }
}
