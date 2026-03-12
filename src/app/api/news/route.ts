import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";

/**
 * GET /api/news
 * Serves active news data from Vercel KV (Upstash Redis)
 */
export async function GET() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return NextResponse.json(
      {
        lastUpdated: new Date().toISOString(),
        source: "No news fetched yet",
        news: [],
        meta: {
          totalCount: 0,
          nextUpdate: new Date().toISOString(),
          archiveUrl: "/api/news-archive",
        },
      },
      { status: 200 }
    );
  }

  try {
    const kv = new Redis({ url, token });
    const newsData = await kv.get<NewsCollection>("news");

    if (!newsData) {
      return NextResponse.json(
        {
          lastUpdated: new Date().toISOString(),
          source: "No news fetched yet",
          news: [],
          meta: {
            totalCount: 0,
            nextUpdate: new Date().toISOString(),
            archiveUrl: "/api/news-archive",
          },
        },
        { status: 200 }
      );
    }

    return NextResponse.json(newsData, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      },
    });
  } catch (error) {
    console.error("Error reading news from KV:", error);
    return NextResponse.json(
      {
        error: "Failed to read news",
        lastUpdated: new Date().toISOString(),
        news: [],
        meta: { totalCount: 0 },
      },
      { status: 200 }
    );
  }
}
