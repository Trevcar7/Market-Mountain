import { NextRequest, NextResponse } from "next/server";
import { NewsCollection, DailyBriefing, NewsItem } from "@/lib/news-types";
import { getRedisClient } from "@/lib/redis";
import type { Redis } from "@upstash/redis";
import { getAnthropicClient, CLAUDE_MODEL } from "@/lib/anthropic-client";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";
import { fetchBriefingMacroPanel, fetchBriefingWhatToWatch } from "@/lib/market-data";

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

  // Detect Vercel cron trigger — force-regenerate when called via cron
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronTrigger = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }

  const key = dateParam ? getDateKey(dateParam) : getTodayKey();
  const date = dateParam ?? new Date().toISOString().split("T")[0];

  // Try to return cached briefing (skip cache on cron trigger to force regeneration)
  if (!isCronTrigger) {
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
  }

  // Generate lazily from today's stories
  if (dateParam && !isCronTrigger) {
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first real prose paragraph from a story body, skipping:
 *  - Bullet lines (• / - / *) that may be leaked MARKET_IMPACT data
 *  - Section headings (## ...)
 *  - Blank lines
 */
function extractLeadParagraph(story: string): string {
  const lines = story.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("##")) continue;
    if (/^[•\-\*]\s/.test(t)) continue;
    // Return the first real prose line (first sentence)
    const firstSentence = t.split(/(?<=[.!?])\s/)[0];
    return firstSentence || t.substring(0, 200);
  }
  return story.substring(0, 200);
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
  const supporting = stories.slice(1, 4); // Always exactly 3 top developments

  // Fetch curated macro panel: 6 institutional-grade indicators
  // (Fed Funds, 10Y Treasury, 2s-10s Spread, CPI YoY, WTI Crude, Dollar Index)
  // This replaces the old approach of two overlapping fetchContextualData calls
  // that produced duplicate yields and a useless raw CPI index level.
  let macroData = stories
    .flatMap((s) => s.keyDataPoints ?? [])
    .filter((d, i, arr) => arr.findIndex((x) => x.label === d.label) === i)
    .slice(0, 6);
  try {
    const freshPanel = await fetchBriefingMacroPanel();
    if (freshPanel.length > 0) {
      macroData = freshPanel;
    }
  } catch {
    // Fine — use story key data as fallback
  }

  // Use Claude to generate structured editorial summaries
  const client = getAnthropicClient();

  const storyContext = stories
    .map(
      (s, i) =>
        `STORY ${i + 1} [${s.category.toUpperCase()}]
Headline: ${s.title}
Why it matters: ${s.whyThisMatters ?? ""}
Summary: ${extractLeadParagraph(s.story)}`
    )
    .join("\n\n");

  const prompt = `You are a macro strategist generating a Daily Markets Briefing for Market Mountain, a financial publication read by institutional investors, macro traders, and portfolio managers.
This briefing publishes at 8:00 AM Eastern each trading day. Your tone must match Bloomberg, the Financial Times, or sell-side macro research notes.

FOCUS: Lead with the story that will move markets most. Skip incremental updates or low-impact developments.

WHAT TO WATCH RULES:
- Each item must identify a specific macro or market driver and explain the mechanism driving markets
- Do NOT use generic phrases like "markets reacted", "this highlights", "investors are watching", "in today's environment"
- Every item must explain the economic cause-and-effect mechanism
- Use one of these monitoring labels for "timing": "Ongoing this week", "Intraday monitoring", "Earnings season updates", "Upcoming economic data", "Policy watch"
- Include a "watchMetric" when a specific price level or threshold is economically meaningful (e.g., "10-Year Treasury above 4.30%", "WTI crude above $95", "S&P 500 testing 50-day MA")
- Significance must be 1-2 sentences maximum, analytical and concise — no speculation or exaggerated predictions

Today's published stories:

${storyContext}

Generate a concise editorial briefing with this exact JSON structure. Return ONLY valid JSON — no markdown, no explanation.
CRITICAL: "topDevelopmentsSummaries" MUST have exactly 3 items. "whatToWatch" MUST have exactly 3 items. No more, no fewer.

{
  "leadSummary": "[2-3 sentence analytical summary of the lead story — what happened, why it moves markets, and the key number or data point investors need to know]",
  "topDevelopmentsSummaries": [
    "[1 sentence for story 2 — focus on the market impact]",
    "[1 sentence for story 3 — focus on the market impact]",
    "[1 sentence for story 4 — focus on the market impact, or synthesize a key macro implication if fewer than 4 stories exist]"
  ],
  "whatToWatch": [
    {"event": "[specific macro or market driver — not generic]", "timing": "[monitoring label from the list above]", "significance": "[1-2 sentences: the economic mechanism and what outcome would move markets]", "watchMetric": "[specific level or threshold to monitor, e.g. '10-Year Treasury above 4.30%']"},
    {"event": "[event name]", "timing": "[monitoring label]", "significance": "[1-2 sentences: cause-and-effect mechanism]", "watchMetric": "[level or null if none applies]"},
    {"event": "[event name]", "timing": "[monitoring label]", "significance": "[1-2 sentences: cause-and-effect mechanism]"}
  ]
}`;

  let generated: {
    leadSummary: string;
    topDevelopmentsSummaries: string[];
    whatToWatch: Array<{ event: string; timing: string; significance: string; watchMetric?: string }>;
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

  // Always try to fill to 3 "What to Watch" items from FMP if Claude
  // returned fewer than 3 (audit found briefings with only 1 item)
  if (whatToWatch.length < 3) {
    try {
      const fmpEvents = await fetchBriefingWhatToWatch();
      // Merge: Claude events first, FMP events fill remaining slots up to 3
      const merged = [...whatToWatch, ...fmpEvents].slice(0, 3);
      whatToWatch = merged.length > 0 ? merged : whatToWatch;
    } catch {
      // Non-fatal — keep whatever Claude returned (possibly empty)
    }
  }

  // Safety net fillers — pad to exactly 3 items
  const WATCH_FILLERS = [
    {
      event: "Next Federal Reserve meeting",
      timing: "Policy watch",
      significance: "Rate decisions drive bond yields and rate-sensitive equity sectors.",
    },
    {
      event: "Upcoming CPI and jobs data",
      timing: "Upcoming economic data",
      significance: "CPI, jobs, and GDP prints shape Fed rate expectations and equity risk premiums.",
    },
    {
      event: "Earnings season updates",
      timing: "Earnings season updates",
      significance: "Company guidance and margin trends reveal whether sector valuations can hold at current levels.",
    },
  ];

  while (whatToWatch.length < 3) {
    const filler = WATCH_FILLERS.find(
      (f) => !whatToWatch.some((w) => w.event === f.event)
    );
    if (!filler) break;
    whatToWatch.push(filler);
  }

  // Hard cap at 3
  whatToWatch = whatToWatch.slice(0, 3);

  const briefing: DailyBriefing = {
    date,
    generatedAt: new Date().toISOString(),
    leadStory: {
      id: leadStory.id,
      title: leadStory.title,
      whyItMatters: leadStory.whyThisMatters ?? extractLeadParagraph(leadStory.story),
      summary: generated?.leadSummary ?? leadStory.whyThisMatters ?? extractLeadParagraph(leadStory.story),
    },
    topDevelopments: supporting.map((s, i) => ({
      id: s.id,
      title: s.title,
      headline: s.title,
      summary:
        generated?.topDevelopmentsSummaries?.[i] ??
        s.whyThisMatters ??
        extractLeadParagraph(s.story),
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
