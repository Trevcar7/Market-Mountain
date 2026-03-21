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
// Active geopolitical themes — ongoing market-moving situations
// ---------------------------------------------------------------------------

/**
 * Detects active geopolitical themes from published stories that should
 * surface in "What to Watch" even when not the day's lead story.
 * Returns human-readable theme descriptions for the Claude prompt.
 */
function detectActiveGeoThemes(stories: NewsItem[]): string[] {
  const themes: string[] = [];
  const allText = stories.map((s) => `${s.title} ${s.story}`).join(" ").toLowerCase();

  // Oil / Iran / Middle East supply risk
  if (/\biran\b|\bstrait of hormuz\b|\bmiddle east.*oil\b|\boil.*iran\b|\bsanctions.*iran\b|\bopec\b/.test(allText)) {
    themes.push("Iran/Middle East oil supply risk: U.S. sanctions on Iranian crude and Strait of Hormuz tensions — monitor WTI crude above $70, Brent-WTI spread, and energy sector ETFs (XLE)");
  }

  // U.S.-China trade / tariffs
  if (/\btariff\b.*\bchina\b|\bchina\b.*\btariff\b|\btrade war\b|\bu\.?s\.?\s*china\b/i.test(allText)) {
    themes.push("U.S.-China trade escalation: tariff announcements and retaliatory measures — monitor USD/CNY, semiconductor supply chains (SMH), and container shipping rates");
  }

  // European energy / Russia
  if (/\brussia\b.*\benergy\b|\benergy\b.*\brussia\b|\bnord stream\b|\beuropean gas\b/.test(allText)) {
    themes.push("European energy security: Russian gas supply dynamics — monitor TTF natural gas futures, EUR/USD, and European industrial production");
  }

  return themes;
}

// ---------------------------------------------------------------------------
// Lead story ranking — multi-factor sort for briefing prominence
// ---------------------------------------------------------------------------

/**
 * Macro-first category weights. The lead story should always be a high-impact
 * macro or policy event, not a company-specific story like Bentley or Humana.
 *
 * Weight scale: higher = more likely to be lead.
 */
const CATEGORY_LEAD_WEIGHT: Record<string, number> = {
  // Tier 1: broad macro — always lead-worthy
  macro: 10,
  policy: 9,
  // Tier 2: broad markets
  markets: 7,
  // Tier 3: sector-specific
  earnings: 5,
  crypto: 4,
  // Tier 4: niche / company-specific
  other: 2,
};

/**
 * Topic keys that indicate broad macro impact — boosted for lead selection.
 */
const HIGH_IMPACT_TOPICS = new Set([
  "federal_reserve", "fed_macro", "inflation", "gdp", "employment",
  "bond_market", "broad_market", "markets", "trade_policy",
  "trade_policy_tariff", "geopolitics",
]);

/**
 * Multi-factor comparator for selecting the lead story.
 * Priority: (1) importance, (2) macro category weight, (3) high-impact topic,
 * (4) number of sources (more corroboration = higher quality),
 * (5) confidence score, (6) market impact breadth.
 */
function rankForLead(a: NewsItem, b: NewsItem): number {
  // 1. Raw importance (higher = better)
  if (a.importance !== b.importance) return b.importance - a.importance;

  // 2. Category weight — macro/policy over earnings/company-specific
  const catA = CATEGORY_LEAD_WEIGHT[a.category] ?? 2;
  const catB = CATEGORY_LEAD_WEIGHT[b.category] ?? 2;
  if (catA !== catB) return catB - catA;

  // 3. High-impact topic boost
  const topicA = HIGH_IMPACT_TOPICS.has(a.topicKey ?? "") ? 1 : 0;
  const topicB = HIGH_IMPACT_TOPICS.has(b.topicKey ?? "") ? 1 : 0;
  if (topicA !== topicB) return topicB - topicA;

  // 4. Source count — more corroboration = more significant
  const srcA = a.sourcesUsed?.length ?? 0;
  const srcB = b.sourcesUsed?.length ?? 0;
  if (srcA !== srcB) return srcB - srcA;

  // 5. Confidence score
  const confA = a.confidenceScore ?? 0;
  const confB = b.confidenceScore ?? 0;
  if (confA !== confB) return confB - confA;

  // 6. Market impact breadth (more assets affected = bigger story)
  const miA = a.marketImpact?.length ?? 0;
  const miB = b.marketImpact?.length ?? 0;
  return miB - miA;
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
      .sort(rankForLead);
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
        stories = eligible.slice(0, 6).sort(rankForLead);
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

  // ── Fetch upcoming macro calendar events FIRST so Claude can prioritize them ──
  // This is the critical fix: Claude must see real scheduled macro events
  // (FOMC, CPI, NFP, etc.) to generate proper "What to Watch" items.
  let upcomingMacroEvents: Array<{
    event: string;
    date: string;
    estimate?: number | null;
    previous?: number | null;
  }> = [];
  try {
    const calendarEvents = await fetchBriefingWhatToWatch();
    upcomingMacroEvents = calendarEvents.map((e) => ({
      event: e.event,
      date: e.timing.replace("Upcoming economic data — ", ""),
      estimate: null,
      previous: null,
    }));
  } catch {
    // Non-fatal — Claude will generate without calendar data
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

  // Build macro calendar block for the prompt
  const macroCalendarBlock = upcomingMacroEvents.length > 0
    ? `\n\nUPCOMING MACRO CALENDAR (this week):\n${upcomingMacroEvents.map((e) => `- ${e.event} (${e.date})`).join("\n")}\n\nIMPORTANT: Your first 1-2 "whatToWatch" items MUST reference these actual scheduled macro events. Only use story-derived themes for the 3rd item if all calendar slots are filled.`
    : "";

  // Build active geopolitical themes block — ongoing market-moving situations
  // that should be considered for What to Watch even if not in today's stories
  const activeGeoThemes = detectActiveGeoThemes(stories);
  const geoThemesBlock = activeGeoThemes.length > 0
    ? `\n\nACTIVE GEOPOLITICAL THEMES (consider for 3rd whatToWatch slot if relevant to today's stories):\n${activeGeoThemes.map((t) => `- ${t}`).join("\n")}`
    : "";

  const prompt = `You are a macro strategist generating a Daily Markets Briefing for Market Mountain, a financial publication read by institutional investors, macro traders, and portfolio managers.
This briefing publishes at 8:00 AM Eastern each trading day. Your tone must match Bloomberg, the Financial Times, or sell-side macro research notes.

FOCUS: Lead with the story that will move markets most. Skip incremental updates or low-impact developments.

STYLE RULES:
- Always write "U.S." (with periods) when referring to the United States — never "US"

WHAT TO WATCH RULES:
- ABSOLUTE PRIORITY: Use the UPCOMING MACRO CALENDAR events below as the first 1-2 "whatToWatch" items. These are real scheduled economic releases from the FMP economic calendar — they MUST take precedence over story-derived themes.
- PRIORITY ORDER: (1) scheduled macro releases from the calendar below (FOMC decisions, CPI, PCE, Non-Farm Payrolls, GDP, PMI/ISM, Retail Sales, PPI, Fed speakers), (2) geopolitical / policy events with market-moving potential from today's stories, (3) major earnings only if no macro events apply
- Each item must identify a specific macro or market driver and explain the mechanism driving markets
- Do NOT use generic phrases like "markets reacted", "this highlights", "investors are watching", "in today's environment"
- Do NOT generate vague ongoing themes like "tariff regime uncertainty" or "inflation persistence" — be specific about WHAT event and WHEN
- Every item must explain the economic cause-and-effect mechanism
- Use one of these monitoring labels for "timing": "Ongoing this week", "Intraday monitoring", "Earnings season updates", "Upcoming economic data", "Policy watch"
- Include a "watchMetric" when a specific price level or threshold is economically meaningful (e.g., "10-Year Treasury above 4.30%", "WTI crude above $95", "S&P 500 testing 50-day MA")
- Significance must be 1-2 sentences maximum, analytical and concise — no speculation or exaggerated predictions

Today's published stories:

${storyContext}${macroCalendarBlock}${geoThemesBlock}

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
    {"event": "[MUST be from UPCOMING MACRO CALENDAR if available — specific scheduled release name and date]", "timing": "[monitoring label from the list above]", "significance": "[1-2 sentences: the economic mechanism and what outcome would move markets]", "watchMetric": "[specific level or threshold to monitor, e.g. '10-Year Treasury above 4.30%']"},
    {"event": "[second calendar event or high-impact geopolitical/policy event]", "timing": "[monitoring label]", "significance": "[1-2 sentences: cause-and-effect mechanism]", "watchMetric": "[level or null if none applies]"},
    {"event": "[third item — a forward-looking signal or remaining calendar event]", "timing": "[monitoring label]", "significance": "[1-2 sentences: cause-and-effect mechanism]"}
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

  // Build "What to Watch" — ensure real macro calendar events take priority
  let whatToWatch = generated?.whatToWatch ?? [];

  // Strip prompt-leak text from Claude's output (e.g., "(Story-derived ...)")
  const PROMPT_LEAK_RE = /\s*\((?:story[- ]derived|calendar[- ]event|from calendar|prompt hint)[^)]*\)/gi;
  for (const item of whatToWatch) {
    item.event = item.event.replace(PROMPT_LEAK_RE, "").trim();
    if (item.significance) item.significance = item.significance.replace(PROMPT_LEAK_RE, "").trim();
  }

  // Post-processing: verify Claude actually used the macro calendar events.
  // If Claude generated vague themes instead of real calendar events,
  // replace the weakest items with actual FMP data.
  if (upcomingMacroEvents.length > 0 && whatToWatch.length > 0) {
    // Check which Claude items reference real calendar events
    const calendarNames = upcomingMacroEvents.map((e) => e.event.toLowerCase());
    const isCalendarItem = (item: { event: string }) =>
      calendarNames.some((name) => item.event.toLowerCase().includes(name.split(" ")[0]));

    const calendarItemCount = whatToWatch.filter(isCalendarItem).length;

    // If Claude didn't include enough calendar events, inject them
    if (calendarItemCount < Math.min(upcomingMacroEvents.length, 2)) {
      try {
        const fmpEvents = await fetchBriefingWhatToWatch();
        // Replace from the back — keep Claude's best item (usually #1), replace #2 and #3
        const keep = whatToWatch.filter(isCalendarItem);
        const fill = fmpEvents.filter(
          (f) => !keep.some((k) => k.event.toLowerCase().includes(f.event.toLowerCase().split(" ")[0]))
        );
        // Calendar events first, then Claude's items
        whatToWatch = [...keep, ...fill, ...whatToWatch.filter((w) => !isCalendarItem(w))]
          .slice(0, 3);
      } catch {
        // Non-fatal
      }
    }
  }

  // Fill remaining slots if Claude returned fewer than 3
  if (whatToWatch.length < 3) {
    try {
      const fmpEvents = await fetchBriefingWhatToWatch();
      const merged = [...whatToWatch, ...fmpEvents].slice(0, 3);
      whatToWatch = merged.length > 0 ? merged : whatToWatch;
    } catch {
      // Non-fatal
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
