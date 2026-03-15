import { NextRequest, NextResponse } from "next/server";
import { NewsCollection, DailyBriefing, NewsItem } from "@/lib/news-types";
import { getRedisClient } from "@/lib/redis";
import type { Redis } from "@upstash/redis";
import { getAnthropicClient, CLAUDE_MODEL } from "@/lib/anthropic-client";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";
import { fetchContextualData, fetchBriefingWhatToWatch } from "@/lib/market-data";

export const maxDuration = 30;
export const runtime = "nodejs";

function getTodayKey(): string {
  return `briefing-${new Date().toISOString().split("T")[0]}`;
}

function getDateKey(date: string): string {
  return `briefing-${date}`;
}

// ---------------------------------------------------------------------------
// GET /api/briefing?date=YYYY-MM-DD (optional)
// Returns today's briefing (or specified date), generating it lazily if absent
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get("date");

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }

  const key = dateParam ? getDateKey(dateParam) : getTodayKey();
  const date = dateParam ?? new Date().toISOString().split("T")[0];

  // Try to return cached briefing
  try {
    const cached = await kv.get<DailyBriefing>(key);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
        },
      });
    }
  } catch {
    // Fall through to generation
  }

  // Generate lazily from today's stories
  if (dateParam) {
    // Historical date with no briefing — not found
    return NextResponse.json({ error: "Briefing not found for this date" }, { status: 404 });
  }

  // Generate today's briefing
  try {
    const briefing = await generateBriefing(kv, date);
    if (!briefing) {
      return NextResponse.json(
        { error: "Not enough stories to generate briefing" },
        { status: 404 }
      );
    }
    return NextResponse.json(briefing, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("[briefing] Generation failed:", error);
    return NextResponse.json({ error: "Briefing generation failed" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/briefing — force-regenerate today's briefing
// Called by fetch-news pipeline after publishing
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get("authorization");
  const secret = process.env.FETCH_NEWS_SECRET;
  if (process.env.NODE_ENV === "production") {
    const token = authHeader?.replace("Bearer ", "") ?? "";
    if (token !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }

  const date = new Date().toISOString().split("T")[0];

  try {
    const briefing = await generateBriefing(kv, date);
    if (!briefing) {
      return NextResponse.json({ success: false, message: "Not enough stories" });
    }
    return NextResponse.json({ success: true, briefing });
  } catch (error) {
    console.error("[briefing] POST generation failed:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Core briefing generation
// ---------------------------------------------------------------------------

async function generateBriefing(
  kv: Redis,
  date: string
): Promise<DailyBriefing | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  // Load today's published stories
  let stories: NewsItem[] = [];
  try {
    const newsData = await kv.get<NewsCollection>("news");
    if (!newsData?.news?.length) return null;

    // Filter to stories published today (and not before March 13 cutoff)
    const todayStart = new Date(date + "T00:00:00Z").getTime();
    const todayEnd = todayStart + 24 * 60 * 60 * 1000;

    stories = newsData.news
      .filter((s) => {
        const t = new Date(s.publishedAt).getTime();
        return t >= todayStart && t < todayEnd && t >= MARCH_13_CUTOFF_MS;
      })
      .sort((a, b) => b.importance - a.importance);
  } catch (err) {
    console.error("[briefing] Failed to load news from KV:", err);
    return null;
  }

  if (stories.length < 2) {
    // Use all available stories if today filter returns too few (e.g., timezone issues)
    try {
      const newsData = await kv.get<NewsCollection>("news");
      const eligible = (newsData?.news ?? []).filter(
        (s) => new Date(s.publishedAt).getTime() >= MARCH_13_CUTOFF_MS
      );
      if (eligible.length >= 2) {
        stories = eligible.slice(0, 6).sort((a, b) => b.importance - a.importance);
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  // Lead story is the highest-importance article
  const leadStory = stories[0];
  const supporting = stories.slice(1, 5);

  // Collect key data points from top stories
  const allKeyData = stories
    .flatMap((s) => s.keyDataPoints ?? [])
    .filter((d, i, arr) => arr.findIndex((x) => x.label === d.label) === i)
    .slice(0, 5);

  // Supplement with fresh macro data if available
  let macroData = allKeyData;
  if (macroData.length < 3) {
    try {
      const fresh = await fetchContextualData("federal_reserve");
      const merged = [...macroData, ...fresh].filter(
        (d, i, arr) => arr.findIndex((x) => x.label === d.label) === i
      );
      macroData = merged.slice(0, 5);
    } catch {
      // Fine — use what we have
    }
  }

  // Use Claude to generate structured editorial summaries
  const client = getAnthropicClient();

  const storyContext = stories
    .map(
      (s, i) =>
        `STORY ${i + 1} [${s.category.toUpperCase()}]
Headline: ${s.title}
Why it matters: ${s.whyThisMatters ?? ""}
Summary: ${s.story.split("\n")[0]}`
    )
    .join("\n\n");

  const prompt = `You are generating a Daily Markets Briefing for Market Mountain, a financial blog.

Today's published stories:

${storyContext}

Generate a concise editorial briefing with this exact JSON structure. Return ONLY valid JSON — no markdown, no explanation:

{
  "leadSummary": "[2-3 sentence analytical summary of the lead story — what happened and why it matters]",
  "topDevelopmentsSummaries": ["[1 sentence for story 2]", "[1 sentence for story 3]", "[1 sentence for story 4]"],
  "whatToWatch": [
    {"event": "[event name]", "timing": "[when]", "significance": "[1 sentence why it matters]"},
    {"event": "[event name]", "timing": "[when]", "significance": "[1 sentence why it matters]"},
    {"event": "[event name]", "timing": "[when]", "significance": "[1 sentence why it matters]"}
  ]
}`;

  let generated: {
    leadSummary: string;
    topDevelopmentsSummaries: string[];
    whatToWatch: Array<{ event: string; timing: string; significance: string }>;
  } | null = null;

  try {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      temperature: 0.5,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      generated = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error("[briefing] Claude call failed:", err);
    // Fall back to using existing story fields
  }

  // Build "What to Watch" — prefer Claude's output, supplement with FMP earnings calendar
  let whatToWatch = generated?.whatToWatch ?? [];

  if (whatToWatch.length < 2) {
    // Fetch FMP-powered events to fill gaps (or as sole source if Claude failed)
    try {
      const fmpEvents = await fetchBriefingWhatToWatch();
      // Merge: Claude events first, FMP events fill remaining slots up to 3
      const merged = [...whatToWatch, ...fmpEvents].slice(0, 3);
      whatToWatch = merged.length > 0 ? merged : whatToWatch;
    } catch {
      // Non-fatal — keep whatever Claude returned (possibly empty)
    }
  }

  // Final safety net — always have at least one event
  if (whatToWatch.length === 0) {
    whatToWatch = [
      {
        event: "Next Federal Reserve meeting",
        timing: "Upcoming",
        significance: "Rate decisions drive bond yields and rate-sensitive equity sectors.",
      },
    ];
  }

  const briefing: DailyBriefing = {
    date,
    generatedAt: new Date().toISOString(),
    leadStory: {
      id: leadStory.id,
      title: leadStory.title,
      whyItMatters: leadStory.whyThisMatters ?? leadStory.story.split(".")[0] + ".",
      summary: generated?.leadSummary ?? leadStory.story.split("\n")[0],
    },
    topDevelopments: supporting.map((s, i) => ({
      id: s.id,
      title: s.title,
      headline: s.title,
      summary:
        generated?.topDevelopmentsSummaries?.[i] ??
        s.whyThisMatters ??
        s.story.split(".")[0] + ".",
      category: s.category,
    })),
    keyData: macroData,
    whatToWatch,
    storiesPublished: stories.length,
    generatedFrom: stories.map((s) => s.id),
  };

  // Save to KV with 48-hour TTL
  try {
    const key = getDateKey(date);
    await kv.set(key, briefing, { ex: 48 * 60 * 60 });
    console.log(`[briefing] Saved briefing for ${date} (${stories.length} stories)`);
  } catch (err) {
    console.error("[briefing] Failed to save to KV:", err);
  }

  return briefing;
}
