import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import Anthropic from "@anthropic-ai/sdk";
import { NewsCollection, NewsItem } from "@/lib/news-types";

export const maxDuration = 60;
export const runtime = "nodejs";

// One-time token — delete this file after use
const ONE_TIME_TOKEN = "a7f3e1c8b2d94f6e0a5c7b3d1e8f2a49";

// ---------------------------------------------------------------------------
// Improvement prompt — polishes editorial fields without rewriting the story
// ---------------------------------------------------------------------------

const IMPROVE_SYSTEM = `You are a senior financial editor at Market Mountain, an independent equity research publication.
Your job is to improve the editorial metadata for an existing news article. You are NOT rewriting the story — only sharpening four specific fields.

RULES:
1. HEADLINE: Make it specific, active, and data-driven. Must be 8–14 words. Must contain the key number or market outcome. No company name as the first word. No dashes. No colons.
2. WHY_MATTERS: One sentence, investor-focused. What does this mean for a portfolio or market position? Must be specific — name an asset class or sector.
3. SECOND_ORDER: One sentence identifying the second-order market implication beyond the headline. Think: what moves next? What does this signal for rates, credit, or sector rotation?
4. WHAT_WATCH: One sentence on the single most important forward-looking metric or event to monitor. Give a specific timeframe or data release where possible.

OUTPUT FORMAT (exactly):
HEADLINE: [improved headline]
WHY_MATTERS: [one sentence]
SECOND_ORDER: [one sentence]
WHAT_WATCH: [one sentence]

Do not output anything else. Do not explain your choices.`;

function createImprovePrompt(article: NewsItem): string {
  return `Improve the editorial metadata for this financial news article.

CURRENT HEADLINE: ${article.title}
CURRENT WHY_MATTERS: ${article.whyThisMatters ?? "(missing)"}
CURRENT SECOND_ORDER: ${article.secondOrderImplication ?? "(missing)"}
CURRENT WHAT_WATCH: ${article.whatToWatchNext ?? "(missing)"}

STORY BODY:
${article.story}

CATEGORY: ${article.category}
RELATED TICKERS: ${(article.relatedTickers ?? []).join(", ") || "none"}

Produce improved versions of all four fields following the rules.`;
}

function parseImprovedFields(raw: string): {
  title?: string;
  whyThisMatters?: string;
  secondOrderImplication?: string;
  whatToWatchNext?: string;
} {
  const result: ReturnType<typeof parseImprovedFields> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("HEADLINE:")) result.title = trimmed.replace("HEADLINE:", "").trim();
    else if (trimmed.startsWith("WHY_MATTERS:")) result.whyThisMatters = trimmed.replace("WHY_MATTERS:", "").trim();
    else if (trimmed.startsWith("SECOND_ORDER:")) result.secondOrderImplication = trimmed.replace("SECOND_ORDER:", "").trim();
    else if (trimmed.startsWith("WHAT_WATCH:")) result.whatToWatchNext = trimmed.replace("WHAT_WATCH:", "").trim();
  }
  return result;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (token !== ONE_TIME_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // "dry" mode — preview without writing changes
  const dry = request.nextUrl.searchParams.get("dry") === "1";

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!kvUrl || !kvToken) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }
  if (!anthropicKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  const kv = new Redis({ url: kvUrl, token: kvToken });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  try {
    const newsData = await kv.get<NewsCollection>("news");
    if (!newsData || !newsData.news.length) {
      return NextResponse.json({ error: "No news data in KV" }, { status: 404 });
    }

    const improved: NewsItem[] = [];
    const log: Array<{ id: string; oldTitle: string; newTitle: string; changed: boolean }> = [];

    for (const article of newsData.news) {
      try {
        const prompt = createImprovePrompt(article);

        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          temperature: 0.4,
          system: IMPROVE_SYSTEM,
          messages: [{ role: "user", content: prompt }],
        });

        const raw = response.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("\n")
          .trim();

        const fields = parseImprovedFields(raw);
        const changed = !!(
          (fields.title && fields.title !== article.title) ||
          fields.whyThisMatters ||
          fields.secondOrderImplication ||
          fields.whatToWatchNext
        );

        log.push({
          id: article.id,
          oldTitle: article.title,
          newTitle: fields.title ?? article.title,
          changed,
        });

        improved.push({
          ...article,
          title: fields.title && fields.title.length > 8 ? fields.title : article.title,
          whyThisMatters: fields.whyThisMatters || article.whyThisMatters,
          secondOrderImplication: fields.secondOrderImplication || article.secondOrderImplication,
          whatToWatchNext: fields.whatToWatchNext || article.whatToWatchNext,
        });

        // Rate-limit: 2-second pause between Claude calls
        await sleep(2000);
      } catch (err) {
        console.error(`[improve] Error on article ${article.id}:`, err);
        improved.push(article); // Keep original on error
        log.push({ id: article.id, oldTitle: article.title, newTitle: article.title, changed: false });
      }
    }

    if (!dry) {
      await kv.set("news", {
        ...newsData,
        lastUpdated: new Date().toISOString(),
        news: improved,
        meta: { ...newsData.meta, totalCount: improved.length },
      });
    }

    return NextResponse.json({
      success: true,
      dry,
      processed: improved.length,
      changed: log.filter((l) => l.changed).length,
      log,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
