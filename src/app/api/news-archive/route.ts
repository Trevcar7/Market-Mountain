import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { ArchivedNewsCollection } from "@/lib/news-types";

/**
 * GET /api/news-archive
 * Serves archived news data (>30 days old) from Vercel KV (Upstash Redis)
 */
export async function GET() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return NextResponse.json(
      {
        lastUpdated: new Date().toISOString(),
        archivedNews: [],
        meta: {
          totalCount: 0,
          oldestStory: "",
          newestStory: "",
        },
      },
      { status: 200 }
    );
  }

  try {
    const kv = new Redis({ url, token });
    const archiveData = await kv.get<ArchivedNewsCollection>("news-archive");

    if (!archiveData) {
      return NextResponse.json(
        {
          lastUpdated: new Date().toISOString(),
          archivedNews: [],
          meta: {
            totalCount: 0,
            oldestStory: "",
            newestStory: "",
          },
        },
        { status: 200 }
      );
    }

    return NextResponse.json(archiveData, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      },
    });
  } catch (error) {
    console.error("Error reading news archive from KV:", error);
    return NextResponse.json(
      {
        error: "Failed to read news archive",
        lastUpdated: new Date().toISOString(),
        archivedNews: [],
        meta: { totalCount: 0 },
      },
      { status: 200 }
    );
  }
}
