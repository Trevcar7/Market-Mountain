import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";

export const runtime = "nodejs";

/**
 * POST /api/admin/update-article
 * One-time admin endpoint — merges supplied fields into an existing news article in KV.
 *
 * Body: { id: string, fields: Partial<NewsItem> }
 * Auth: Authorization: Bearer {FETCH_NEWS_SECRET}
 *
 * Remove this file once the article update is complete.
 */
export async function POST(request: Request) {
  // Auth check
  const authHeader = request.headers.get("Authorization");
  const expectedToken = process.env.FETCH_NEWS_SECRET;

  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (!kvUrl || !kvToken) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  try {
    const body = await request.json() as { id?: string; fields?: Record<string, unknown> };
    const { id, fields } = body;

    if (!id || !fields || typeof fields !== "object") {
      return NextResponse.json({ error: "Missing id or fields" }, { status: 400 });
    }

    const kv = new Redis({ url: kvUrl, token: kvToken });
    const newsData = await kv.get<NewsCollection>("news");

    if (!newsData) {
      return NextResponse.json({ error: "No news collection found in KV" }, { status: 404 });
    }

    const idx = newsData.news.findIndex((n) => n.id === id);
    if (idx === -1) {
      return NextResponse.json({ error: `Article "${id}" not found` }, { status: 404 });
    }

    // Merge new fields into article
    const updated = { ...newsData.news[idx], ...fields };
    newsData.news[idx] = updated;

    await kv.set("news", newsData);

    console.log(`[admin/update-article] Updated article "${id}" — fields: ${Object.keys(fields).join(", ")}`);

    return NextResponse.json({
      success: true,
      id,
      updatedFields: Object.keys(fields),
      article: updated,
    });
  } catch (error) {
    console.error("[admin/update-article] Error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
