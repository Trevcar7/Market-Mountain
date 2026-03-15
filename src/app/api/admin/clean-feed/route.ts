import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection } from "@/lib/news-types";

export const maxDuration = 30;
export const runtime = "nodejs";

/**
 * POST /api/admin/clean-feed
 * Remove specific news items from the live feed.
 *
 * Auth: Bearer token matching FETCH_NEWS_SECRET
 *
 * Body:
 *   { "removeIds": ["news-xxx", "news-yyy"] }
 *
 * Response:
 *   { removed, kept, remaining: NewsItem[] }
 */
export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get("authorization");
  const expectedToken = process.env.FETCH_NEWS_SECRET;

  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();

  if (!kv) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  let removeIds: string[] = [];
  try {
    const body = await request.json();
    if (!Array.isArray(body.removeIds)) {
      return NextResponse.json(
        { error: "removeIds must be an array of string IDs" },
        { status: 400 }
      );
    }
    removeIds = body.removeIds.map(String);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (removeIds.length === 0) {
    return NextResponse.json({ error: "removeIds is empty" }, { status: 400 });
  }

  try {
    const newsData = await kv.get<NewsCollection>("news");

    if (!newsData) {
      return NextResponse.json({ error: "No news data in KV" }, { status: 404 });
    }

    const removeSet = new Set(removeIds);
    const before = newsData.news.length;
    const filtered = newsData.news.filter((item) => !removeSet.has(item.id));
    const removed = before - filtered.length;

    if (removed === 0) {
      return NextResponse.json({
        message: "No matching IDs found — nothing changed",
        removed: 0,
        kept: before,
        queriedIds: removeIds,
        availableIds: newsData.news.map((n) => n.id),
      });
    }

    const updated: NewsCollection = {
      ...newsData,
      lastUpdated: new Date().toISOString(),
      news: filtered,
      meta: {
        ...newsData.meta,
        totalCount: filtered.length,
      },
    };

    await kv.set("news", updated);

    console.log(
      `[clean-feed] Removed ${removed} articles: [${removeIds.join(", ")}]`
    );

    return NextResponse.json({
      success: true,
      removed,
      kept: filtered.length,
      removedIds: removeIds.filter((id) => removeSet.has(id) && !filtered.some((n) => n.id === id)),
      remaining: filtered.map((n) => ({ id: n.id, title: n.title, publishedAt: n.publishedAt })),
    });
  } catch (err) {
    console.error("[clean-feed] KV error:", err);
    return NextResponse.json(
      { error: "KV read/write failed", detail: String(err) },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/clean-feed
 * List all current article IDs (for identifying what to remove).
 * Auth required.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expectedToken = process.env.FETCH_NEWS_SECRET;

  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();

  if (!kv) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  try {
    const newsData = await kv.get<NewsCollection>("news");

    if (!newsData) {
      return NextResponse.json({ articles: [], total: 0 });
    }

    return NextResponse.json({
      total: newsData.news.length,
      articles: newsData.news.map((n) => ({
        id: n.id,
        title: n.title,
        publishedAt: n.publishedAt,
        importance: n.importance,
        category: n.category,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "KV read failed", detail: String(err) },
      { status: 500 }
    );
  }
}
