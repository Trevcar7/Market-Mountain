/**
 * POST /api/news/correct
 *
 * Editorial correction endpoint — applies targeted text replacements and/or
 * field updates to an already-published story in the Redis KV feed.
 *
 * Use cases:
 *   - Fixing factual discrepancies discovered after publication (e.g., conflicting
 *     oil prices across two stories published in the same cycle)
 *   - Clarifying chart labels or captions without republishing the full article
 *   - Correcting typographical errors in headlines or body copy
 *
 * Security: requires Authorization: Bearer <FETCH_NEWS_SECRET> in production.
 *
 * Request body:
 * {
 *   "id": "story-uuid",
 *   "replacements": [
 *     { "field": "story", "from": "$92 per barrel", "to": "near $99 per barrel" }
 *   ],
 *   "fieldUpdates": {
 *     "chartData": [...]   // optional: replace entire field value
 *   },
 *   "reason": "Human-readable explanation logged for audit trail"
 * }
 *
 * Returns:
 * {
 *   "success": true,
 *   "corrected": { id, title, changesApplied: number },
 *   "reason": "..."
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection, NewsItem } from "@/lib/news-types";

export const runtime = "nodejs";

// Fields that support text search-and-replace
const TEXT_FIELDS: Array<keyof NewsItem> = [
  "title",
  "story",
  "whyThisMatters",
  "whatToWatchNext",
  "secondOrderImplication",
];

// Fields that support chart-label patching (array of objects with a "title" key)
const CHART_LABEL_FIELDS: Array<keyof NewsItem> = ["chartData"];

interface TextReplacement {
  /** Which NewsItem field to apply the replacement to. */
  field: string;
  /** Exact string to find (case-sensitive). */
  from: string;
  /** Replacement string. */
  to: string;
}

interface CorrectionRequest {
  /** ID of the story to correct. */
  id: string;
  /** Zero or more search-and-replace operations on text fields. */
  replacements?: TextReplacement[];
  /**
   * Optional full-field overrides (e.g., replace entire chartData array).
   * Accepts any NewsItem field key → new value.
   */
  fieldUpdates?: Partial<Record<string, unknown>>;
  /** Human-readable reason — written to the console audit log. */
  reason?: string;
}

export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = request.headers.get("authorization");
  const secret = process.env.FETCH_NEWS_SECRET;

  if (process.env.NODE_ENV === "production") {
    const token = authHeader?.replace("Bearer ", "") ?? "";
    if (!secret || token !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: CorrectionRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, replacements = [], fieldUpdates = {}, reason = "editorial correction" } = body;

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Missing or invalid story id" }, { status: 400 });
  }
  if (replacements.length === 0 && Object.keys(fieldUpdates).length === 0) {
    return NextResponse.json(
      { error: "No replacements or fieldUpdates provided" },
      { status: 400 }
    );
  }

  // ── Load feed from Redis ──────────────────────────────────────────────────
  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }

  let collection: NewsCollection | null;
  try {
    collection = await kv.get<NewsCollection>("news");
  } catch (err) {
    console.error("[news/correct] Failed to read from Redis:", err);
    return NextResponse.json({ error: "Failed to read feed from storage" }, { status: 500 });
  }

  if (!collection?.news?.length) {
    return NextResponse.json({ error: "No news feed found in storage" }, { status: 404 });
  }

  const storyIndex = collection.news.findIndex((s) => s.id === id);
  if (storyIndex === -1) {
    return NextResponse.json(
      { error: `Story not found: ${id}` },
      { status: 404 }
    );
  }

  const original = collection.news[storyIndex];
  const corrected: NewsItem = { ...original };
  let changesApplied = 0;

  // ── Apply text replacements ───────────────────────────────────────────────
  for (const rep of replacements) {
    const { field, from, to } = rep;

    if (!TEXT_FIELDS.includes(field as keyof NewsItem)) {
      console.warn(`[news/correct] Skipping unsupported text field: "${field}"`);
      continue;
    }

    const currentValue = corrected[field as keyof NewsItem];
    if (typeof currentValue !== "string") {
      console.warn(`[news/correct] Field "${field}" is not a string — skipping`);
      continue;
    }

    if (!currentValue.includes(from)) {
      console.warn(
        `[news/correct] Replacement not applied: "${from}" not found in field "${field}" of story "${id}"`
      );
      continue;
    }

    // Replace all occurrences
    const updated = currentValue.split(from).join(to);
    (corrected as unknown as Record<string, unknown>)[field] = updated;
    changesApplied++;
    console.log(
      `[news/correct] Applied replacement in field "${field}": ` +
      `"${from}" → "${to}" (story: "${corrected.title}")`
    );
  }

  // ── Apply chart-label replacements (search within chartData[].title) ─────
  // Special case: "field": "chartData.title" applies replacements to chart titles
  for (const rep of replacements) {
    if (rep.field !== "chartData.title" && !CHART_LABEL_FIELDS.includes(rep.field as keyof NewsItem)) {
      continue;
    }
    if (rep.field === "chartData.title" && Array.isArray(corrected.chartData)) {
      corrected.chartData = corrected.chartData.map((chart) => {
        if (typeof chart.title === "string" && chart.title.includes(rep.from)) {
          changesApplied++;
          console.log(
            `[news/correct] Updated chart title: "${rep.from}" → "${rep.to}"`
          );
          return { ...chart, title: chart.title.split(rep.from).join(rep.to) };
        }
        return chart;
      });
    }
  }

  // ── Apply full-field overrides ────────────────────────────────────────────
  for (const [key, value] of Object.entries(fieldUpdates)) {
    (corrected as unknown as Record<string, unknown>)[key] = value;
    changesApplied++;
    console.log(`[news/correct] Full-field override applied: "${key}" (story: "${corrected.title}")`);
  }

  if (changesApplied === 0) {
    return NextResponse.json({
      success: false,
      message: "No changes were applied — check that replacement strings exist in the target fields",
      storyId: id,
      storyTitle: original.title,
    });
  }

  // ── Write corrected feed back to Redis ───────────────────────────────────
  collection.news[storyIndex] = corrected;
  collection.lastUpdated = new Date().toISOString();

  try {
    await kv.set("news", collection);
  } catch (err) {
    console.error("[news/correct] Failed to write corrected feed to Redis:", err);
    return NextResponse.json(
      { error: "Failed to save corrections to storage" },
      { status: 500 }
    );
  }

  console.log(
    `[news/correct] AUDIT: story="${corrected.title}" id=${id} ` +
    `changes=${changesApplied} reason="${reason}"`
  );

  return NextResponse.json({
    success: true,
    corrected: {
      id: corrected.id,
      title: corrected.title,
      changesApplied,
    },
    reason,
  });
}
