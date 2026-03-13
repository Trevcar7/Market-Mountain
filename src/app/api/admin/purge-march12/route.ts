import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";

export const maxDuration = 30;
export const runtime = "nodejs";

// One-time token — delete this file after use
const ONE_TIME_TOKEN = "093de56ca243d72d0037329f7772e03a";

// All articles before this timestamp are March 12 or earlier
const MARCH_13_CUTOFF_MS = 1773360000000;

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (token !== ONE_TIME_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!url || !kvToken) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  const kv = new Redis({ url, token: kvToken });

  try {
    const newsData = await kv.get<NewsCollection>("news");
    if (!newsData) {
      return NextResponse.json({ error: "No news data in KV" }, { status: 404 });
    }

    const before = newsData.news.length;
    const deleted = newsData.news.filter(
      (item) => new Date(item.publishedAt).getTime() < MARCH_13_CUTOFF_MS
    );
    const kept = newsData.news.filter(
      (item) => new Date(item.publishedAt).getTime() >= MARCH_13_CUTOFF_MS
    );

    if (deleted.length === 0) {
      return NextResponse.json({
        message: "No March 12 articles found — nothing to delete",
        total: before,
      });
    }

    await kv.set("news", {
      ...newsData,
      lastUpdated: new Date().toISOString(),
      news: kept,
      meta: { ...newsData.meta, totalCount: kept.length },
    });

    return NextResponse.json({
      success: true,
      deleted: deleted.length,
      kept: kept.length,
      deletedArticles: deleted.map((a) => ({ id: a.id, title: a.title, publishedAt: a.publishedAt })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
