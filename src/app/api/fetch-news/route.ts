import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import {
  fetchFinnhubNews,
  fetchNewsAPINews,
  filterByRelevance,
  deduplicateNews,
  groupRelatedArticles,
} from "@/lib/news";
import { synthesizeGroupedArticles } from "@/lib/news-synthesis";
import { NewsCollection, ArchivedNewsCollection, NewsItem } from "@/lib/news-types";

const RETENTION_DAYS = 30;

// Initialize Upstash Redis client (Vercel injects KV_REST_API_URL and KV_REST_API_TOKEN)
function getRedisClient(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn("KV env vars not set — falling back to no-op storage");
    return null;
  }
  return new Redis({ url, token });
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
 * GitHub Actions trigger (authenticates via Bearer token)
 */
export async function POST(request: NextRequest) {
  // Verify GitHub Actions Bearer token
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.NEXT_PUBLIC_FETCH_NEWS_SECRET;

  if (process.env.NODE_ENV === "production") {
    const token = authHeader?.replace("Bearer ", "") || "";
    if (token !== expectedSecret) {
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
    const kv = getRedisClient();

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
    const { active, archived } = await loadNewsWithArchival(kv);

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

    // 9. Hard cap at 5 articles per day (keep only top 5 by importance + recency)
    const sortedStories = activeStories
      .sort((a, b) => {
        // Primary: importance score (descending)
        if (b.importance !== a.importance) {
          return b.importance - a.importance;
        }
        // Secondary: recency (descending)
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      })
      .slice(0, 5); // Hard cap at 5

    // 10. Save active news to KV
    const newsCollection: NewsCollection = {
      lastUpdated: new Date().toISOString(),
      source: "Finnhub + NewsAPI (synthesized via Claude, fact-checked)",
      news: sortedStories,
      meta: {
        totalCount: sortedStories.length,
        nextUpdate: getNextUpdateTime(),
        archiveUrl: "/api/news-archive",
      },
    };

    if (kv) {
      await kv.set("news", newsCollection);
    }

    // 11. Save archive to KV
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

      if (kv) {
        await kv.set("news-archive", archiveCollection);
      }
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
 * Load existing news and archive from KV
 */
async function loadNewsWithArchival(
  kv: Redis | null
): Promise<{ active: NewsItem[]; archived: NewsItem[] }> {
  let active: NewsItem[] = [];
  let archived: NewsItem[] = [];

  if (!kv) return { active, archived };

  try {
    const data = await kv.get<NewsCollection>("news");
    if (data) {
      active = data.news || [];
    }
  } catch (error) {
    console.error("Error loading active news from KV:", error);
  }

  try {
    const data = await kv.get<ArchivedNewsCollection>("news-archive");
    if (data) {
      archived = data.archivedNews?.map(({ archivedAt, ...item }) => item) || [];
    }
  } catch (error) {
    console.error("Error loading archived news from KV:", error);
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
 * Calculate next update time (for 10x daily: 7am, 9am, 10am, 12pm, 1pm, 2pm, 3pm, 4pm, 6pm, 8pm EST)
 */
function getNextUpdateTime(): string {
  const now = new Date();
  const estTime = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  const hour = estTime.getHours();
  const updateHours = [7, 9, 10, 12, 13, 14, 15, 16, 18, 20]; // EST times

  // Find next update time today
  for (const updateHour of updateHours) {
    if (hour < updateHour) {
      const nextUpdate = new Date(estTime);
      nextUpdate.setHours(updateHour, 0, 0, 0);
      return nextUpdate.toISOString();
    }
  }

  // If past all times today, next update is 7 AM tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(7, 0, 0, 0);
  return tomorrow.toISOString();
}
