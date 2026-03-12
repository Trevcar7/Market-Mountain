import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  fetchFinnhubNews,
  fetchNewsAPINews,
  filterByRelevance,
  deduplicateNews,
  groupRelatedArticles,
} from "@/lib/news";
import { synthesizeGroupedArticles } from "@/lib/news-synthesis";
import { NewsCollection, ArchivedNewsCollection, NewsItem } from "@/lib/news-types";

const DATA_DIR = path.join(process.cwd(), "public/data");
const ACTIVE_NEWS_FILE = path.join(DATA_DIR, "news.json");
const ARCHIVE_NEWS_FILE = path.join(DATA_DIR, "news-archive.json");
const RETENTION_DAYS = 30;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * GET /api/fetch-news
 * Manual trigger for fetching news (for testing)
 */
export async function GET(request: NextRequest) {
  // Verify auth token
  const token = request.headers.get("x-fetch-news-token");
  const expectedToken = process.env.NEXT_PUBLIC_FETCH_NEWS_SECRET;

  if (token !== expectedToken && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return handleNewsFetch();
}

/**
 * POST /api/fetch-news
 * Vercel Cron trigger (authenticates via secret)
 */
export async function POST(request: NextRequest) {
  // Verify Vercel Cron signature
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.NEXT_PUBLIC_FETCH_NEWS_SECRET;

  if (process.env.NODE_ENV === "production") {
    if (!authHeader || !authHeader.includes(expectedSecret || "")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return handleNewsFetch();
}

/**
 * Main news fetching and processing pipeline
 */
async function handleNewsFetch() {
  const startTime = Date.now();
  const stats = {
    fetchedFinnhub: 0,
    fetchedNewsAPI: 0,
    filtered: 0,
    deduplicated: 0,
    synthesized: 0,
    posted: 0,
    rejected: 0,
    archived: 0,
    errors: 0,
    executionMs: 0,
  };

  try {
    // 1. Fetch from both sources in parallel
    const [finnhubArticles, newsapiArticles] = await Promise.all([
      fetchFinnhubNews(process.env.FINNHUB_API_KEY || ""),
      fetchNewsAPINews(process.env.NEWSAPI_API_KEY || ""),
    ]);

    stats.fetchedFinnhub = finnhubArticles.length;
    stats.fetchedNewsAPI = newsapiArticles.length;

    // 2. Combine and filter
    const allArticles = [...finnhubArticles, ...newsapiArticles];
    const relevant = filterByRelevance(allArticles);
    stats.filtered = relevant.length;

    // 3. Deduplicate
    const unique = deduplicateNews(relevant);
    stats.deduplicated = unique.length;

    if (unique.length === 0) {
      return NextResponse.json({
        message: "No relevant news found",
        stats,
      });
    }

    // 4. Group related articles
    const grouped = groupRelatedArticles(unique);

    // 5. Synthesize with Gemini
    const { stories, stats: synthStats } = await synthesizeGroupedArticles(grouped);
    stats.posted = synthStats.posted;
    stats.rejected = synthStats.rejected;
    stats.errors = synthStats.errors;

    // 6. Load existing news and archive old stories
    const { active, archived } = loadNewsWithArchival();

    // 7. Merge new stories with existing (avoid duplicates)
    const allStories = mergeNewsWithDedup([...stories, ...active]);

    // 8. Separate active (last 30 days) from archive
    const now = Date.now();
    const thirtyDaysMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const activeStories = allStories.filter((story) => {
      const storyDate = new Date(story.publishedAt).getTime();
      return now - storyDate < thirtyDaysMs;
    });

    const archiveStories = allStories.filter((story) => {
      const storyDate = new Date(story.publishedAt).getTime();
      return now - storyDate >= thirtyDaysMs;
    });

    stats.archived = archiveStories.length;

    // 9. Save active news
    const newsCollection: NewsCollection = {
      lastUpdated: new Date().toISOString(),
      source: "Finnhub + NewsAPI (synthesized via Gemini, fact-checked)",
      news: activeStories.sort(
        (a, b) =>
          new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      ),
      meta: {
        totalCount: activeStories.length,
        nextUpdate: getNextUpdateTime(),
        archiveUrl: "/api/news-archive",
      },
    };

    fs.writeFileSync(ACTIVE_NEWS_FILE, JSON.stringify(newsCollection, null, 2));

    // 10. Save archive
    if (archiveStories.length > 0) {
      const archiveCollection: ArchivedNewsCollection = {
        lastUpdated: new Date().toISOString(),
        archivedNews: archiveStories
          .map((story) => ({
            ...story,
            archivedAt: new Date().toISOString(),
          }))
          .sort(
            (a, b) =>
              new Date(b.publishedAt).getTime() -
              new Date(a.publishedAt).getTime()
          ),
        meta: {
          totalCount: archiveStories.length,
          oldestStory: archiveStories[archiveStories.length - 1]?.publishedAt || "",
          newestStory: archiveStories[0]?.publishedAt || "",
        },
      };

      fs.writeFileSync(
        ARCHIVE_NEWS_FILE,
        JSON.stringify(archiveCollection, null, 2)
      );
    }

    stats.executionMs = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      message: `Fetched ${stats.fetchedFinnhub + stats.fetchedNewsAPI} articles, posted ${stats.posted} stories`,
      stats,
      nextUpdate: newsCollection.meta.nextUpdate,
    });
  } catch (error) {
    console.error("News fetch error:", error);
    stats.executionMs = Date.now() - startTime;

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        stats,
      },
      { status: 500 }
    );
  }
}

/**
 * Load existing news and archive
 */
function loadNewsWithArchival(): { active: NewsItem[]; archived: NewsItem[] } {
  let active: NewsItem[] = [];
  let archived: NewsItem[] = [];

  try {
    if (fs.existsSync(ACTIVE_NEWS_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(ACTIVE_NEWS_FILE, "utf-8")
      ) as NewsCollection;
      active = data.news || [];
    }
  } catch (error) {
    console.error("Error loading active news:", error);
  }

  try {
    if (fs.existsSync(ARCHIVE_NEWS_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(ARCHIVE_NEWS_FILE, "utf-8")
      ) as ArchivedNewsCollection;
      archived = data.archivedNews?.map(({ archivedAt, ...item }) => item) || [];
    }
  } catch (error) {
    console.error("Error loading archived news:", error);
  }

  return { active, archived };
}

/**
 * Merge new stories with existing, avoiding duplicates
 */
function mergeNewsWithDedup(stories: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const merged: NewsItem[] = [];

  for (const story of stories) {
    // Use title as dedup key
    if (!seen.has(story.title.toLowerCase())) {
      seen.add(story.title.toLowerCase());
      merged.push(story);
    }
  }

  return merged;
}

/**
 * Calculate next update time (for 3x daily: 7am, 12pm, 6pm EST)
 */
function getNextUpdateTime(): string {
  const now = new Date();
  const estTime = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  const hour = estTime.getHours();
  let nextHour = 7; // 7 AM

  if (hour < 7) {
    nextHour = 7;
  } else if (hour < 12) {
    nextHour = 12;
  } else if (hour < 18) {
    nextHour = 18;
  } else {
    // Next day 7 AM
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(7, 0, 0, 0);
    return tomorrow.toISOString();
  }

  const nextUpdate = new Date(estTime);
  nextUpdate.setHours(nextHour, 0, 0, 0);
  return nextUpdate.toISOString();
}
