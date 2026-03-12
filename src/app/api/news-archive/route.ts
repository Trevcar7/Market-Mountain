import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * GET /api/news-archive
 * Serves archived news data (>30 days old)
 */
export async function GET() {
  const ARCHIVE_NEWS_FILE = path.join("/tmp", "news-archive.json");

  try {
    // Check if archive data exists
    if (!fs.existsSync(ARCHIVE_NEWS_FILE)) {
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

    // Read and return archived news
    const archiveData = JSON.parse(
      fs.readFileSync(ARCHIVE_NEWS_FILE, "utf-8")
    );
    return NextResponse.json(archiveData, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      },
    });
  } catch (error) {
    console.error("Error reading news archive:", error);
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
