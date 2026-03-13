import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";
import { BLOCKED_SOURCES } from "@/lib/news";

export const maxDuration = 30;
export const runtime = "nodejs";

// One-time token — delete this file after use
const ONE_TIME_TOKEN = "b5c2f9d3e7a14b8c0d6e2f1a3b9c5d7e";

// Known-good fallback images keyed by topic
const TOPIC_IMAGE_FIXES: Record<string, string> = {
  inflation: "https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?w=1200&q=80",   // US dollar bills
  federal_reserve: "https://images.unsplash.com/photo-1569025591598-35bcd6438bda?w=1200&q=80", // Fed building
  broad_market: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",    // Stock screens
  energy: "https://images.unsplash.com/photo-1466611653911-95081537e5b7?w=1200&q=80",          // Oil platform
  crypto: "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80",          // Bitcoin coin
  markets: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
};

// Unsplash photo IDs that are known to be foreign grocery/produce images
const BAD_PHOTO_IDS = [
  "1632175771754", // foreign supermarket / produce (inflation search result)
  "1681684564271", // uncertain origin from broad search
];

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (token !== ONE_TIME_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dry = request.nextUrl.searchParams.get("dry") === "1";

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  const kv = new Redis({ url: kvUrl, token: kvToken });

  try {
    const newsData = await kv.get<NewsCollection>("news");
    if (!newsData || !newsData.news.length) {
      return NextResponse.json({ error: "No news data in KV" }, { status: 404 });
    }

    const imagePatches: string[] = [];
    const sourcesPatched: string[] = [];

    const patched = newsData.news.map((article) => {
      let updated = { ...article };

      // 1. Fix bad images — replace known foreign/irrelevant Unsplash photos
      //    with topic-appropriate fallbacks
      const hasBadPhoto = BAD_PHOTO_IDS.some((id) => article.imageUrl?.includes(id));
      if (hasBadPhoto) {
        const fix =
          TOPIC_IMAGE_FIXES[article.topicKey ?? ""] ??
          TOPIC_IMAGE_FIXES[article.category] ??
          "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80";
        updated.imageUrl = fix;
        imagePatches.push(`[${article.id}] "${article.title}" → ${fix}`);
      }

      // 2. Strip blocked sources from sourcesUsed
      const before = updated.sourcesUsed.length;
      updated.sourcesUsed = updated.sourcesUsed.filter((s) => {
        const lower = s.source.toLowerCase();
        return !BLOCKED_SOURCES.some((blocked) => lower.includes(blocked));
      });
      const removed = before - updated.sourcesUsed.length;
      if (removed > 0) {
        sourcesPatched.push(`[${article.id}] removed ${removed} blocked source(s)`);
      }

      return updated;
    });

    if (!dry) {
      await kv.set("news", {
        ...newsData,
        lastUpdated: new Date().toISOString(),
        news: patched,
        meta: { ...newsData.meta, totalCount: patched.length },
      });
    }

    return NextResponse.json({
      success: true,
      dry,
      imagePatches,
      sourcesPatched,
      totalArticles: patched.length,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
