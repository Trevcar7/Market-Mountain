/**
 * ONE-TIME ADMIN ENDPOINT — clear-news-feed
 *
 * Deletes all news data from KV: active feed, archive, and cross-run topic memory.
 * Remove this file after use.
 *
 * Usage:
 *   curl -X POST https://market-mountain.com/api/admin/clear-news-feed \
 *     -H "Authorization: Bearer YOUR_FETCH_NEWS_SECRET"
 */

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const secret = process.env.FETCH_NEWS_SECRET;

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  const kv = new Redis({ url, token });

  const results: Record<string, string> = {};

  for (const key of ["news", "news-archive", "news-recent-topics"]) {
    try {
      await kv.del(key);
      results[key] = "deleted";
    } catch (err) {
      results[key] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  console.log("[admin/clear-news-feed] KV keys cleared:", results);

  return NextResponse.json({
    success: true,
    message: "All news KV keys cleared. Remove this endpoint after use.",
    cleared: results,
  });
}
