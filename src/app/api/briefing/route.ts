import { NextRequest, NextResponse } from "next/server";
import { NewsCollection, DailyBriefing, NewsItem } from "@/lib/news-types";
import { getRedisClient } from "@/lib/redis";
import type { Redis } from "@upstash/redis";
import { getAnthropicClient, CLAUDE_MODEL } from "@/lib/anthropic-client";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";
import { fetchBriefingMacroPanel, fetchBriefingWhatToWatch, FOMC_2026_MEETINGS } from "@/lib/market-data";
import { applyArticlePatches } from "@/lib/news-patches";

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

/** Geopolitical theme descriptions keyed by structured tag */
const GEO_THEME_DESCRIPTIONS: Record<string, string> = {
  iran_oil_supply: "Iran/Middle East oil supply risk: U.S. sanctions on Iranian crude and Strait of Hormuz tensions — monitor WTI crude above $70, Brent-WTI spread, and energy sector ETFs (XLE)",
  us_china_trade: "U.S.-China trade escalation: tariff announcements and retaliatory measures — monitor USD/CNY, semiconductor supply chains (SMH), and container shipping rates",
  russia_energy: "European energy security: Russian gas supply dynamics — monitor TTF natural gas futures, EUR/USD, and European industrial production",
  middle_east_conflict: "Middle East conflict escalation: military operations and humanitarian crisis — monitor oil prices, defense sector (ITA), and safe-haven assets (gold, USD, treasuries)",
  taiwan_risk: "Taiwan Strait risk: military posturing and semiconductor supply chain disruption — monitor TSM, semiconductor ETFs (SMH/SOXX), and USD/TWD",
  sanctions: "Sanctions escalation: new financial or trade restrictions — monitor affected country currencies, commodity flows, and sanctioned sector equities",
  tariffs: "Tariff policy shifts: new duties or exemptions affecting trade flows — monitor affected sector ETFs, import-dependent companies, and consumer prices",
  opec_supply: "OPEC+ supply dynamics: production quota changes and compliance — monitor WTI/Brent crude, energy sector equities (XLE), and inflation expectations",
  european_energy: "European energy security: supply disruptions and storage levels — monitor TTF natural gas futures, EUR/USD, and European industrial production",
};

/**
 * Detects active geopolitical themes from published stories.
 * Primary: uses structured geoThemes tags from synthesis (reliable).
 * Fallback: regex detection for stories without structured tags.
 */
function detectActiveGeoThemes(stories: NewsItem[]): string[] {
  const themes: string[] = [];
  const seenTags = new Set<string>();

  // Primary: use structured geoThemes tags from synthesis
  for (const story of stories) {
    if (story.geoThemes) {
      for (const tag of story.geoThemes) {
        if (!seenTags.has(tag) && GEO_THEME_DESCRIPTIONS[tag]) {
          seenTags.add(tag);
          themes.push(GEO_THEME_DESCRIPTIONS[tag]);
        }
      }
    }
  }

  // Fallback: regex detection for stories without structured tags
  if (seenTags.size === 0) {
    const allText = stories.map((s) => `${s.title} ${s.story}`).join(" ").toLowerCase();

    if (/\biran\b|\bstrait of hormuz\b|\bmiddle east.*oil\b|\boil.*iran\b|\bsanctions.*iran\b|\bopec\b/.test(allText)) {
      themes.push(GEO_THEME_DESCRIPTIONS.iran_oil_supply);
    }
    if (/\btariff\b.*\bchina\b|\bchina\b.*\btariff\b|\btrade war\b|\bu\.?s\.?\s*china\b/i.test(allText)) {
      themes.push(GEO_THEME_DESCRIPTIONS.us_china_trade);
    }
    if (/\brussia\b.*\benergy\b|\benergy\b.*\brussia\b|\bnord stream\b|\beuropean gas\b/.test(allText)) {
      themes.push(GEO_THEME_DESCRIPTIONS.russia_energy);
    }
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
/** Strips parenthetical prompt-leak text Claude echoes from template hints. */
const PROMPT_LEAK_RE = /\s*\((?:story[- ]derived|calendar[- ]event|from calendar|prompt hint|forward[- ]looking signal|remaining calendar|monitoring label)[^)]*\)/gi;

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
      .map(applyArticlePatches)
      .sort(rankForLead);
  } catch (err) {
    console.error("[briefing] Failed to load news from KV:", err);
    return null;
  }

  if (stories.length < 2) {
    // Use all available stories if today filter returns too few (e.g., timezone issues)
    try {
      const newsData = await kv.get<NewsCollection>("news");
      const eligible = (newsData?.news ?? [])
        .filter((s) => new Date(s.publishedAt).getTime() >= MARCH_13_CUTOFF_MS)
        .map(applyArticlePatches);
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

  // ── Fetch yesterday's briefing for editorial continuity ──
  // Provides Claude with context to avoid repeating What to Watch items
  // and to generate follow-up items on resolved events.
  let yesterdayBriefing: DailyBriefing | null = null;
  try {
    const yesterday = new Date(new Date(date + "T12:00:00Z").getTime() - 24 * 60 * 60 * 1000)
      .toISOString().split("T")[0];
    yesterdayBriefing = await kv.get<DailyBriefing>(getDateKey(yesterday));
    if (yesterdayBriefing) {
      console.log(`[briefing] Loaded yesterday's briefing (${yesterday}) for continuity`);
    }
  } catch {
    // Non-fatal — generate without continuity context
  }

  const yesterdayBlock = yesterdayBriefing
    ? `\n\nYESTERDAY'S BRIEFING (${yesterdayBriefing.date}) — for continuity:
Lead story: ${yesterdayBriefing.leadStory.title}
What to Watch items:
${yesterdayBriefing.whatToWatch.map((w, i) => `${i + 1}. ${w.event} — ${w.significance}`).join("\n")}

CONTINUITY RULES:
- Do NOT repeat the same "What to Watch" items from yesterday unless there is a genuine new development
- If any of yesterday's watch items have resolved or had new data, generate a brief follow-up in the "followUpItems" array
- If none of yesterday's items resolved, omit the "followUpItems" field`
    : "";

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

  // Build macro calendar block for the prompt — include FOMC date
  const todayStr = new Date().toISOString().split("T")[0];
  const nextFomc = FOMC_2026_MEETINGS.find((m) => m.end >= todayStr);
  const fomcLine = nextFomc
    ? `- FOMC Meeting: ${nextFomc.start} to ${nextFomc.end}${nextFomc.sep ? " (includes SEP + dot plot)" : ""} — ${Math.floor((new Date(nextFomc.start).getTime() - Date.now()) / 86400000)} days away`
    : "";
  const calendarLines = [
    ...upcomingMacroEvents.map((e) => `- ${e.event} (${e.date})`),
    ...(fomcLine ? [fomcLine] : []),
  ];
  const macroCalendarBlock = calendarLines.length > 0
    ? `\n\nUPCOMING MACRO CALENDAR:\n${calendarLines.join("\n")}\n\nIMPORTANT: Reference specific upcoming macro events in "whatToWatch". Do NOT duplicate — if you mention FOMC, mention it ONCE with the specific date. Only use story-derived themes for remaining slots.`
    : "";

  // ── Categorize stories by theme for structured prompt ──
  // Instead of generic geo theme boilerplate, give Claude real story headlines
  // grouped by theme so it can pick diverse items.
  const STORY_THEME_CLUSTERS: Array<{ label: string; terms: string[] }> = [
    { label: "FED/MONETARY POLICY", terms: ["fomc", "federal reserve", "fed meeting", "rate decision", "rate cut", "rate hike", "fed funds", "monetary policy", "powell"] },
    { label: "OIL/ENERGY", terms: ["oil", "crude", "wti", "brent", "opec", "iran", "energy sector", "strait of hormuz", "petroleum", "refinery", "natural gas"] },
    { label: "INFLATION", terms: ["cpi", "pce", "inflation", "ppi", "consumer price", "price index"] },
    { label: "TRADE/TARIFFS", terms: ["tariff", "trade war", "trade policy", "china trade", "import dut", "trade deal", "sanctions"] },
    { label: "EMPLOYMENT", terms: ["non-farm", "nonfarm", "payroll", "unemployment", "jobless", "jobs report", "labor market"] },
    { label: "GDP/GROWTH", terms: ["gdp", "recession", "economic growth"] },
    { label: "EARNINGS", terms: ["earnings", "revenue", "guidance", "quarter results", "eps estimate"] },
    { label: "BONDS/RATES", terms: ["treasury", "yield curve", "10-year", "bond auction", "2-year"] },
    { label: "TECH/AI", terms: ["artificial intelligence", " ai ", "semiconductor", "chip", "nvidia", "openai", "anthropic", "meta platform", "apple", "microsoft", "google", "amazon"] },
    { label: "CRYPTO", terms: ["bitcoin", "crypto", "ethereum", "btc"] },
  ];

  function classifyStoryTheme(s: NewsItem): string {
    const text = `${s.title} ${s.whyThisMatters ?? ""} ${s.category}`.toLowerCase();
    for (const cluster of STORY_THEME_CLUSTERS) {
      if (cluster.terms.some((term) => text.includes(term))) {
        return cluster.label;
      }
    }
    return s.category.toUpperCase();
  }

  // Group story headlines by theme
  const themeToHeadlines = new Map<string, string[]>();
  for (const s of stories) {
    const theme = classifyStoryTheme(s);
    const existing = themeToHeadlines.get(theme) ?? [];
    existing.push(s.title);
    themeToHeadlines.set(theme, existing);
  }

  const storyThemesBlock = themeToHeadlines.size > 0
    ? `\n\nSTORY THEMES FOR WHAT TO WATCH (pick from DIFFERENT themes — never two from the same):
${[...themeToHeadlines.entries()].map(([theme, headlines]) => `— ${theme}: ${headlines.map((h) => `"${h.length > 70 ? h.substring(0, 67) + "..." : h}"`).join(", ")}`).join("\n")}

USE THESE THEMES to ensure diversity. Each whatToWatch item must come from a DIFFERENT theme row above (or from the MACRO CALENDAR).`
    : "";

  const prompt = `You are a macro strategist generating a Daily Markets Briefing for Market Mountain, a financial publication read by institutional investors, macro traders, and portfolio managers.
This briefing publishes at 8:00 AM Eastern each trading day. Your tone must match Bloomberg, the Financial Times, or sell-side macro research notes.

FOCUS: Lead with the story driving the largest market reaction TODAY. Skip incremental updates. Prioritize:
1. What is moving prices RIGHT NOW (rates, equities, commodities, FX)
2. What macro data is driving the reaction (CPI, NFP, FOMC, GDP)
3. What is the forward-looking signal (next data release, policy shift, earnings)

STYLE RULES:
- Always write "U.S." (with periods) when referring to the United States — never "US"
- Be direct and specific — every sentence must contain either a number, a date, or a clear mechanism
- Write like a sell-side morning note, not a news summary

WHAT TO WATCH RULES:
- ABSOLUTE PRIORITY: Use the UPCOMING MACRO CALENDAR events below as the first whatToWatch item. These are real scheduled economic releases.
- Pick 3 items from 3 DIFFERENT theme rows listed in "STORY THEMES FOR WHAT TO WATCH" below. Never pick two items from the same theme.
- TIMING ACCURACY: Use the EXACT dates from the UPCOMING MACRO CALENDAR. Do NOT say "this week" or "next week" unless the event is actually within 7 days. If an event is 14+ days away, say "on [date]" or "[X] days away". NEVER guess timing.
- Each item MUST answer: "What specific event? When exactly? What price/rate level matters? What happens if it beats/misses?"
- Significance: 1-2 sentences MAX. State the mechanism: "If X happens → Y moves because Z"
- "watchMetric" is REQUIRED for every item — the specific price level or threshold (e.g., "10-Year above 4.50%", "WTI crude above $72/bbl", "S&P 500 support at 5,600")
- Do NOT use: "markets reacted", "investors are watching", "remains to be seen", "this highlights", "in today's environment"
- Do NOT generate vague themes — every item must reference a specific event, date, or data release

Today's published stories:

${storyContext}${macroCalendarBlock}${storyThemesBlock}${yesterdayBlock}

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
    {"event": "[specific event name with date]", "timing": "[date or timeframe]", "significance": "[1-2 sentences: If X → Y because Z]", "watchMetric": "[specific threshold, e.g. 'WTI crude above $72/bbl']"},
    {"event": "[DIFFERENT theme from item 1]", "timing": "[date or timeframe]", "significance": "[1-2 sentences: mechanism]", "watchMetric": "[specific threshold]"},
    {"event": "[DIFFERENT theme from items 1 and 2]", "timing": "[date or timeframe]", "significance": "[1-2 sentences: mechanism]", "watchMetric": "[specific threshold]"}
  ],
  "followUpItems": [
    {"originalEvent": "[yesterday's watch item that resolved]", "outcome": "[1 sentence: what happened — e.g. 'CPI came in at 2.6% vs 2.7% expected, reinforcing June rate cut expectations']"}
  ]
}`;

  let generated: {
    leadSummary: string;
    topDevelopmentsSummaries: string[];
    whatToWatch: Array<{ event: string; timing: string; significance: string; watchMetric?: string }>;
    followUpItems?: Array<{ originalEvent: string; outcome: string }>;
  } | null = null;

  try {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      temperature: 0.3,
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

  // Dedup: remove duplicate FOMC items (Claude may generate one AND fallback may inject one)
  const fomcItems = whatToWatch.filter((w) => /fomc|federal open market/i.test(w.event));
  if (fomcItems.length > 1) {
    // Keep the longest/most detailed FOMC item, remove the rest
    const bestFomc = fomcItems.reduce((best, item) =>
      item.significance.length > best.significance.length ? item : best
    );
    whatToWatch = whatToWatch.filter((w) => !(/fomc|federal open market/i.test(w.event)) || w === bestFomc);
  }

  // Fill remaining slots if Claude returned fewer than 3
  if (whatToWatch.length < 3) {
    try {
      const fmpEvents = await fetchBriefingWhatToWatch();
      // Filter out FOMC from fmpEvents if we already have one
      const hasFomc = whatToWatch.some((w) => /fomc|federal open market/i.test(w.event));
      const filtered = hasFomc ? fmpEvents.filter((e) => !/fomc|federal open market/i.test(e.event)) : fmpEvents;
      const merged = [...whatToWatch, ...filtered].slice(0, 3);
      whatToWatch = merged.length > 0 ? merged : whatToWatch;
    } catch {
      // Non-fatal
    }
  }

  // Safety net fillers — pad to exactly 3 items.
  // Each filler covers a DISTINCT macro category so replacements always add diversity.
  const WATCH_FILLERS = [
    {
      event: "U.S. tariff and trade policy developments",
      timing: "Policy watch — ongoing",
      significance: "Tariff announcements directly impact import costs, corporate margins, and sector rotation between domestic producers and importers.",
      watchMetric: "USD/CNY; tariff-exposed sector ETFs; container shipping rates",
    },
    {
      event: "Upcoming inflation data (CPI/PCE)",
      timing: "Upcoming economic data",
      significance: "Core inflation prints drive Fed rate expectations, moving Treasury yields, mortgage rates, and rate-sensitive equity sectors.",
      watchMetric: "Core CPI MoM vs. 0.3% consensus; 10-Year breakeven inflation rate",
    },
    {
      event: "U.S. labor market data",
      timing: "Upcoming economic data",
      significance: "Non-farm payrolls, unemployment rate, and wage growth influence Fed rate timing and consumer spending trajectory.",
      watchMetric: "NFP vs. consensus; unemployment rate; average hourly earnings MoM",
    },
    {
      event: "Earnings season forward guidance",
      timing: "Earnings season",
      significance: "Management guidance and margin trends from mega-cap reports reveal whether current valuations can hold.",
      watchMetric: "S&P 500 forward P/E ratio; earnings revision breadth",
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

  // ── Post-processing: fix FOMC timing hallucinations ──
  // Claude may say "this week" or "next week" for FOMC when it's actually 30+ days away.
  // Replace with the actual date from the hardcoded calendar.
  if (nextFomc) {
    const daysToFomc = Math.floor((new Date(nextFomc.start).getTime() - Date.now()) / 86400000);
    const fomcDateLabel = `${nextFomc.start} to ${nextFomc.end}`;
    const fomcMonth = new Date(nextFomc.start + "T12:00:00Z").toLocaleString("en-US", { month: "long" });
    const fomcShortLabel = `${fomcMonth} ${parseInt(nextFomc.start.slice(8), 10)}–${parseInt(nextFomc.end.slice(8), 10)}`;

    for (const item of whatToWatch) {
      const itemText = `${item.event} ${item.significance ?? ""} ${item.timing ?? ""}`;
      const isFomcItem = /fomc|federal open market|fed\s+meeting|rate\s+decision/i.test(itemText);
      if (!isFomcItem) continue;

      // Fix "this week" / "next week" when FOMC is >7 days away
      if (daysToFomc > 7) {
        item.event = item.event.replace(/\b(this|next)\s+week(?:'s)?\b/gi, fomcShortLabel);
        if (item.significance) {
          item.significance = item.significance.replace(/\b(this|next)\s+week(?:'s)?\b/gi, `on ${fomcShortLabel}`);
        }
      }

      // Ensure timing field includes actual date, not just a vague label
      if (item.timing && !/\d{4}/.test(item.timing) && !/\d+\s+days?\s+away/i.test(item.timing)) {
        item.timing = `${daysToFomc} days away — ${fomcDateLabel}`;
      }
    }
  }

  // ── Post-processing: enforce topic diversity via entity-cluster overlap ──
  // The old theme-based classifier only picked ONE category per item, so two items
  // about Iran/oil could be classified as different themes ("inflation" vs "oil_energy")
  // and slip through. This approach groups related entities into clusters and checks
  // whether any two items share a cluster — catching editorial overlap reliably.
  const ENTITY_CLUSTERS: Array<{ name: string; terms: string[] }> = [
    { name: "fed_monetary", terms: ["fomc", "federal reserve", "fed meeting", "rate decision", "rate cut", "rate hike", "fed funds", "monetary policy", "powell"] },
    { name: "oil_iran_energy", terms: ["oil", "crude", "wti", "brent", "opec", "iran", "energy sector", "strait of hormuz", "middle east oil", "petroleum", "refinery"] },
    { name: "inflation_prices", terms: ["cpi", "pce", "inflation", "ppi", "consumer price", "price index"] },
    { name: "trade_tariffs", terms: ["tariff", "trade war", "trade policy", "china trade", "import dut", "trade deal"] },
    { name: "employment_labor", terms: ["non-farm", "nonfarm", "payroll", "unemployment", "jobless", "jobs report", "labor market"] },
    { name: "gdp_growth", terms: ["gdp", "recession", "economic growth", "ism ", "pmi "] },
    { name: "earnings", terms: ["earnings", "revenue", "guidance", "quarter results", "eps"] },
    { name: "treasury_bonds", terms: ["treasury", "yield curve", "10-year", "bond auction", "2-year"] },
  ];

  function getItemClusters(item: { event: string; significance?: string; timing?: string }): Set<string> {
    const text = `${item.event} ${item.significance ?? ""} ${item.timing ?? ""}`.toLowerCase();
    const matched = new Set<string>();
    for (const cluster of ENTITY_CLUSTERS) {
      if (cluster.terms.some((term) => text.includes(term))) {
        matched.add(cluster.name);
      }
    }
    return matched;
  }

  function itemsOverlap(
    a: { event: string; significance?: string; timing?: string },
    b: { event: string; significance?: string; timing?: string },
  ): boolean {
    const clustersA = getItemClusters(a);
    const clustersB = getItemClusters(b);
    for (const c of clustersA) {
      if (clustersB.has(c)) return true;
    }
    return false;
  }

  // Pairwise overlap check — replace the weaker item in each overlapping pair
  for (let i = 0; i < whatToWatch.length; i++) {
    for (let j = i + 1; j < whatToWatch.length; j++) {
      if (!itemsOverlap(whatToWatch[i], whatToWatch[j])) continue;

      // Keep the item with longer significance (more detailed); replace the other
      const weakerIdx = (whatToWatch[i].significance?.length ?? 0) >= (whatToWatch[j].significance?.length ?? 0) ? j : i;

      // Collect clusters used by the items we're keeping
      const keptClusters = new Set<string>();
      for (let k = 0; k < whatToWatch.length; k++) {
        if (k === weakerIdx) continue;
        for (const c of getItemClusters(whatToWatch[k])) keptClusters.add(c);
      }

      // Try story-derived replacement first — build a watch item from an actual
      // published story that covers a different theme cluster.
      let replaced = false;
      for (const story of stories) {
        const storyText = `${story.title} ${story.whyThisMatters ?? ""} ${story.category}`.toLowerCase();
        const storyClusters = new Set<string>();
        for (const cluster of ENTITY_CLUSTERS) {
          if (cluster.terms.some((term) => storyText.includes(term))) {
            storyClusters.add(cluster.name);
          }
        }
        // Check that this story doesn't overlap with kept items
        let overlapsKept = false;
        for (const c of storyClusters) {
          if (keptClusters.has(c)) { overlapsKept = true; break; }
        }
        if (overlapsKept || storyClusters.size === 0) continue;

        // Build a watch item from this story
        const eventTitle = story.title.length > 80 ? story.title.substring(0, 77) + "..." : story.title;
        whatToWatch[weakerIdx] = {
          event: eventTitle,
          timing: "Forward-looking signal",
          significance: (story.whyThisMatters ?? extractLeadParagraph(story.story)).substring(0, 200),
          watchMetric: story.marketImpact?.[0]
            ? `${story.marketImpact[0].asset}: ${story.marketImpact[0].direction}`
            : undefined,
        };
        replaced = true;
        console.log(`[briefing] Items ${i} and ${j} overlap — replaced item ${weakerIdx} with story: "${eventTitle}"`);
        break;
      }

      // Fallback to WATCH_FILLERS if no story available
      if (!replaced) {
        const filler = WATCH_FILLERS.find((f) => {
          const fc = getItemClusters(f);
          for (const c of fc) {
            if (keptClusters.has(c)) return false;
          }
          return true;
        });
        if (filler) {
          whatToWatch[weakerIdx] = filler;
          console.log(`[briefing] Items ${i} and ${j} overlap — replaced item ${weakerIdx} with filler: "${filler.event}"`);
        }
      }
      break; // Fix one overlap per pass; re-entering would need a fresh scan
    }
  }

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
    // Include follow-up items if Claude generated any from yesterday's context
    ...(generated?.followUpItems && generated.followUpItems.length > 0 && yesterdayBriefing
      ? {
          followUpItems: generated.followUpItems.map((f) => ({
            originalEvent: f.originalEvent,
            originalDate: yesterdayBriefing!.date,
            outcome: f.outcome,
          })),
        }
      : {}),
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
