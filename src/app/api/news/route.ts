import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * GET /api/news
 * Serves cached news data from /tmp/news.json
 * Frontend fetches from this endpoint instead of static file
 */
export async function GET() {
  const ACTIVE_NEWS_FILE = path.join("/tmp", "news.json");

  try {
    // Check if news data exists
    if (!fs.existsSync(ACTIVE_NEWS_FILE)) {
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

    // Read and return cached news
    const newsData = JSON.parse(fs.readFileSync(ACTIVE_NEWS_FILE, "utf-8"));
    return NextResponse.json(newsData, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      },
    });
  } catch (error) {
    console.error("Error reading news cache:", error);
    return NextResponse.json(
      {
        error: "Failed to read news cache",
        lastUpdated: new Date().toISOString(),
        news: [],
        meta: { totalCount: 0 },
      },
      { status: 200 }
    );
  }
}
