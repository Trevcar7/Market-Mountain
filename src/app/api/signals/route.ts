import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { SignalsCollection, NewsCollection } from "@/lib/news-types";
import { generateMarketSignals } from "@/lib/signals";

export const runtime = "nodejs";

// Signals are valid for 1 hour — regenerate only when stale
const KV_KEY = "market-signals";

/**
 * GET /api/signals
 * Returns current market signals (3–5 directional views).
 * Serves cached KV data if still valid; regenerates when expired.
 */
export async function GET() {
  const kv = getRedisClient();

  if (!kv) {
    return NextResponse.json(
      { signals: [], generatedAt: null, validUntil: null, source: "No KV configured" },
      { status: 200 }
    );
  }

  try {

    // Check cache
    const cached = await kv.get<SignalsCollection>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      return NextResponse.json(cached, {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
        },
      });
    }

    // Load today's news to generate signals from
    const newsData = await kv.get<NewsCollection>("news");
    const stories = newsData?.news ?? [];

    if (stories.length === 0) {
      return NextResponse.json(
        { signals: [], generatedAt: new Date().toISOString(), validUntil: null, source: "No news available" },
        { status: 200 }
      );
    }

    // Generate fresh signals
    const collection = await generateMarketSignals(stories);

    if (!collection) {
      return NextResponse.json(
        { signals: [], generatedAt: new Date().toISOString(), validUntil: null, source: "Generation failed" },
        { status: 200 }
      );
    }

    // Cache for 1 hour
    await kv.set(KV_KEY, collection, { ex: 3600 });

    return NextResponse.json(collection, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("[/api/signals] Error:", error);
    return NextResponse.json(
      { signals: [], error: "Failed to load signals" },
      { status: 500 }
    );
  }
}
