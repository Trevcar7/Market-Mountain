import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import {
  fetchFinnhubNews,
  fetchNewsAPIMultiple,
  filterByRelevance,
  filterByAge,
  deduplicateNews,
  groupRelatedArticles,
} from "@/lib/news";
import { synthesizeGroupedArticles } from "@/lib/news-synthesis";
import { NewsCollection, ArchivedNewsCollection, NewsItem } from "@/lib/news-types";

export const maxDuration = 60; // Vercel Pro: up to 60s (synthesis takes 25-50s)
export const runtime = "nodejs";

const RETENTION_DAYS = 30;

// Per-topic cooldown windows (hours) — prevents re-synthesizing the same topic
const TOPIC_DEDUP_HOURS: Record<string, number> = {
  federal_reserve: 8,
  fed_macro: 8,
  inflation: 8,
  gdp: 12,
  employment: 8,
  bond_market: 6,
  trade_policy: 6,
  broad_market: 4,
  crypto: 4,
  earnings: 4,
  energy: 6,
  merger_acquisition: 8,
  bankruptcy: 12,
};
const DEFAULT_DEDUP_HOURS = 6;

// Per-category cap per run — prevents 3 macro stories when only 1 event happened
const PER_CATEGORY_CAP: Record<string, number> = {
  macro: 2,
  earnings: 3,
  markets: 2,
  policy: 2,
  crypto: 2,
  other: 2,
};

const MIN_IMPORTANCE = 8;
const MAX_GROUPS_PER_RUN = 3; // 3 groups × ~15s each + sleeps ≈ 50s, safely under 60s maxDuration
const MIN_STORIES_TO_PUBLISH = 3; // Publish Decision Layer: require ≥3 quality stories

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------

function getRedisClient(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn("KV env vars not set — falling back to no-op storage");
    return null;
  }
  return new Redis({ url, token });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

interface HealthStatus {
  status: "healthy" | "degraded" | "critical";
  missing: string[];
  warnings: string[];
}

function healthCheck(): HealthStatus {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.KV_REST_API_URL) missing.push("KV_REST_API_URL");
  if (!process.env.KV_REST_API_TOKEN) missing.push("KV_REST_API_TOKEN");
  if (!process.env.FETCH_NEWS_SECRET) missing.push("FETCH_NEWS_SECRET");

  if (!process.env.FINNHUB_API_KEY) warnings.push("FINNHUB_API_KEY not set — Finnhub source disabled");
  if (!process.env.NEWSAPI_API_KEY) warnings.push("NEWSAPI_API_KEY not set — NewsAPI source disabled");
  if (!process.env.UNSPLASH_ACCESS_KEY) warnings.push("UNSPLASH_ACCESS_KEY not set — using fallback images");

  const status =
    missing.length > 0 ? "critical" : warnings.length > 0 ? "degraded" : "healthy";

  return { status, missing, warnings };
}

// ---------------------------------------------------------------------------
// GET /api/fetch-news — manual trigger for testing
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const token = request.headers.get("x-fetch-news-token");
  const expectedToken = process.env.FETCH_NEWS_SECRET;

  if (token !== expectedToken && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return handleNewsFetch();
}

// ---------------------------------------------------------------------------
// POST /api/fetch-news — GitHub Actions trigger
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.FETCH_NEWS_SECRET;

  if (process.env.NODE_ENV === "production") {
    const token = authHeader?.replace("Bearer ", "") || "";
    if (token !== expectedSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return handleNewsFetch();
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function handleNewsFetch() {
  const startTime = Date.now();

  // Health check — log always, abort only if critical env vars missing
  const health = healthCheck();
  console.log(`[fetch-news] Health: ${health.status}`, {
    missing: health.missing,
    warnings: health.warnings,
  });

  if (health.missing.length > 0) {
    console.error(`[fetch-news] CRITICAL: Missing env vars: ${health.missing.join(", ")}`);
    return NextResponse.json(
      { success: false, error: "Missing required env vars", missing: health.missing },
      { status: 500 }
    );
  }

  const stats = {
    fetchedFinnhub: 0,
    fetchedNewsAPI: 0,
    filtered: 0,
    deduplicated: 0,
    posted: 0,
    rejected: 0,
    archived: 0,
    errors: 0,
    crossRunSuppressed: 0,
    executionMs: 0,
    publishDecision: "pending" as "pending" | "published" | "skipped" | "insufficient",
    storiesWithWhyMatters: 0,
    storiesWithKeyData: 0,
  };

  try {
    const kv = getRedisClient();

    // Guard: if Redis is unavailable, don't waste Anthropic API credits
    if (!kv) {
      console.error("[fetch-news] CRITICAL: KV client not initialized — aborting to avoid wasted synthesis");
      return NextResponse.json(
        { success: false, error: "Redis KV not configured — news would not be saved" },
        { status: 500 }
      );
    }

    // 1. Fetch from both sources in parallel
    const [finnhubArticles, newsapiArticles] = await Promise.all([
      fetchFinnhubNews(process.env.FINNHUB_API_KEY || ""),
      fetchNewsAPIMultiple(process.env.NEWSAPI_API_KEY || ""),
    ]);

    stats.fetchedFinnhub = finnhubArticles.length;
    stats.fetchedNewsAPI = newsapiArticles.length;

    console.log(`[fetch-news] Fetched: Finnhub=${finnhubArticles.length}, NewsAPI=${newsapiArticles.length}`);

    // 2. Age-filter (12h) then relevance-filter
    const allArticles = [...finnhubArticles, ...newsapiArticles];
    const fresh = filterByAge(allArticles, 12);
    const relevant = filterByRelevance(fresh);
    stats.filtered = relevant.length;

    console.log(`[fetch-news] After age+relevance filter: ${relevant.length} articles (${allArticles.length - fresh.length} dropped as stale)`);

    // 3. Deduplicate
    const unique = deduplicateNews(relevant);
    stats.deduplicated = unique.length;

    console.log(`[fetch-news] After deduplication: ${unique.length} unique articles`);

    if (unique.length === 0) {
      console.warn("[fetch-news] No relevant news found after filtering & dedup");
      return NextResponse.json({ message: "No relevant news found", stats, health: health.warnings });
    }

    // 4. Group related articles
    const grouped = groupRelatedArticles(unique);
    console.log(`[fetch-news] Grouped into ${grouped.length} topic groups`);

    // 4a. Require minimum 2 sources per group
    const qualifiedGroups = grouped.filter((g) => g.articles.length >= 2);
    console.log(`[fetch-news] ${qualifiedGroups.length} groups have 2+ sources (${grouped.length - qualifiedGroups.length} dropped)`);

    if (qualifiedGroups.length === 0) {
      console.warn("[fetch-news] No qualified groups (2+ sources) — skipping synthesis this run");
      return NextResponse.json({ message: "No qualified groups found", stats, health: health.warnings });
    }

    // 4b. LOAD existing stories early — needed for cross-run topic dedup
    const { active: existingActive, archived: existingArchived } =
      await loadNewsWithArchival(kv);

    // 4c. Cross-run topic dedup — skip topics covered within their cooldown window
    const recentTopics = extractRecentTopicKeys(existingActive, TOPIC_DEDUP_HOURS, DEFAULT_DEDUP_HOURS);
    console.log(`[fetch-news] Recently covered topics (within cooldown): [${[...recentTopics].join(", ")}]`);

    const afterCrossRunDedup = qualifiedGroups.filter((g) => {
      if (recentTopics.has(g.topic)) {
        console.log(`[fetch-news] Cross-run suppressed: "${g.topic}" (covered within cooldown window)`);
        return false;
      }
      return true;
    });
    stats.crossRunSuppressed = qualifiedGroups.length - afterCrossRunDedup.length;

    // 4d. Per-category cap
    const categoryCount: Record<string, number> = {};
    const afterCategoryCap = afterCrossRunDedup.filter((g) => {
      const cat = g.category;
      categoryCount[cat] = (categoryCount[cat] ?? 0) + 1;
      const cap = PER_CATEGORY_CAP[cat] ?? 2;
      if (categoryCount[cat] > cap) {
        console.log(`[fetch-news] Category cap: dropping "${g.topic}" (${cat} already at ${cap})`);
        return false;
      }
      return true;
    });

    // 4e. Minimum importance floor
    const afterImportanceFloor = afterCategoryCap.filter((g) => {
      if (g.importance < MIN_IMPORTANCE) {
        console.log(`[fetch-news] Low importance: dropping "${g.topic}" (score=${g.importance})`);
        return false;
      }
      return true;
    });

    // 4f. Cap total groups per run
    const groupsToSynthesize = afterImportanceFloor.slice(0, MAX_GROUPS_PER_RUN);

    console.log(`[fetch-news] Final groups to synthesize: ${groupsToSynthesize.length} (cross-run suppressed=${stats.crossRunSuppressed})`);

    if (groupsToSynthesize.length === 0) {
      console.warn("[fetch-news] No groups remain after filters — skipping synthesis this run");
      return NextResponse.json({ message: "All topics recently covered or below quality threshold", stats, health: health.warnings });
    }

    // 5. Synthesize with Claude
    console.log(`[fetch-news] Starting synthesis on ${groupsToSynthesize.length} groups`);
    const { stories, stats: synthStats } = await synthesizeGroupedArticles(groupsToSynthesize);
    stats.posted = synthStats.posted;
    stats.rejected = synthStats.rejected;
    stats.errors = synthStats.errors;

    console.log(`[fetch-news] Synthesis complete: posted=${synthStats.posted}, rejected=${synthStats.rejected}, errors=${synthStats.errors}`);

    // 5b. Publish Decision Layer — require ≥3 quality stories with whyThisMatters
    const qualityStories = stories.filter(
      (s) => s.whyThisMatters && s.whyThisMatters.length > 10
    );
    stats.storiesWithWhyMatters = qualityStories.length;
    stats.storiesWithKeyData = stories.filter((s) => (s.keyDataPoints?.length ?? 0) > 0).length;

    if (stories.length < MIN_STORIES_TO_PUBLISH && existingActive.length === 0) {
      stats.publishDecision = "insufficient";
      stats.executionMs = Date.now() - startTime;
      console.warn(
        `[fetch-news] Publish decision: SKIP — only ${stories.length} new stories (need ${MIN_STORIES_TO_PUBLISH})`
      );
      return NextResponse.json({
        success: true,
        message: `Only ${stories.length} new stories synthesized — publish threshold not met, existing feed preserved`,
        stats,
        health: health.warnings,
      });
    }
    stats.publishDecision = "published";
    console.log(
      `[fetch-news] Publish decision: PUBLISH — ${stories.length} new stories (${stats.storiesWithWhyMatters} with why-matters, ${stats.storiesWithKeyData} with key data)`
    );

    // 5a. Write newly covered topics to Redis for cross-run memory
    if (stories.length > 0) {
      const topicUpdates: Record<string, string> = {};
      for (const story of stories) {
        if (story.topicKey) {
          topicUpdates[story.topicKey] = story.publishedAt;
        }
      }
      if (Object.keys(topicUpdates).length > 0) {
        try {
          await kv.hset("news-recent-topics", topicUpdates);
          await kv.expire("news-recent-topics", 48 * 60 * 60); // 48h TTL
          console.log(`[fetch-news] Updated cross-run topic memory: [${Object.keys(topicUpdates).join(", ")}]`);
        } catch (err) {
          console.error("[fetch-news] Failed to write recent topics to Redis:", err);
        }
      }
    }

    // 6. Merge new stories with existing (topicKey-aware dedup)
    const allStories = mergeNewsWithDedup([...stories, ...existingActive]);

    // 7. Separate active (last 30 days) from archive
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

    // 8. Sort by recency, then importance — keep up to 30 stories
    const sortedStories = activeStories
      .sort((a, b) => {
        const timeDiff = new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.importance - a.importance;
      })
      .slice(0, 30);

    // 9. Save active news to KV
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

    try {
      await kv.set("news", newsCollection);
      console.log(`[fetch-news] Saved ${sortedStories.length} active stories to Redis KV`);
    } catch (redisError) {
      console.error("[fetch-news] CRITICAL: Failed to write active news to Redis:", redisError);
      return NextResponse.json(
        { success: false, error: "Redis write failed", stats },
        { status: 500 }
      );
    }

    // 10. Save archive to KV
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

      try {
        await kv.set("news-archive", archiveCollection);
        console.log(`[fetch-news] Saved ${archiveStories.length} archived stories to Redis KV`);
      } catch (err) {
        console.error("[fetch-news] Failed to write archive to Redis:", err);
      }
    }

    // 11. Trigger briefing generation asynchronously (fire-and-forget, don't block response)
    if (stats.posted > 0) {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://marketmountainfinance.com";
      const secret = process.env.FETCH_NEWS_SECRET ?? "";
      fetch(`${siteUrl}/api/briefing`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
      }).catch((err) => {
        console.warn("[fetch-news] Briefing trigger failed (non-fatal):", err instanceof Error ? err.message : String(err));
      });
      console.log("[fetch-news] Briefing generation triggered");
    }

    stats.executionMs = Date.now() - startTime;

    console.log(`[fetch-news] FINAL STATS: ${JSON.stringify(stats)}`);

    return NextResponse.json({
      success: true,
      message: `Fetched ${stats.fetchedFinnhub + stats.fetchedNewsAPI} articles, posted ${stats.posted} stories`,
      stats,
      health: health.warnings,
      nextUpdate: newsCollection.meta.nextUpdate,
      publishDecision: stats.publishDecision,
    });
  } catch (error) {
    console.error("[fetch-news] Fatal error:", error);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract topic keys from existing stories that were posted within their cooldown window.
 */
function extractRecentTopicKeys(
  stories: NewsItem[],
  topicTtlMap: Record<string, number>,
  defaultHours: number
): Set<string> {
  const now = Date.now();
  const recentTopics = new Set<string>();

  for (const story of stories) {
    const key = story.topicKey;
    if (!key) continue; // Legacy story without topicKey — skip

    const windowHours = topicTtlMap[key] ?? defaultHours;
    const windowMs = windowHours * 60 * 60 * 1000;
    const storyAge = now - new Date(story.publishedAt).getTime();

    if (storyAge < windowMs) {
      recentTopics.add(key);
    }
  }

  return recentTopics;
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
 * Simple hash function for content deduplication
 */
function hashContent(text: string): string {
  let hash = 0;
  const str = text.substring(0, 200);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString();
}

/**
 * Merge new stories with existing, deduplicating by title+content AND topicKey.
 * New stories are passed first, so newest-first ordering means the first
 * story encountered per topicKey is always the most recent — older duplicates are dropped.
 */
function mergeNewsWithDedup(stories: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const seenTopicKeys = new Set<string>();
  const merged: NewsItem[] = [];

  for (const story of stories) {
    // Standard title + content hash dedup
    const titleKey = story.title.toLowerCase();
    const contentHash = hashContent(story.story);
    const uniqueKey = `${titleKey}|${contentHash}`;

    if (seen.has(uniqueKey)) continue;

    // topicKey dedup: first-encountered wins (newest first since new stories are prepended)
    if (story.topicKey) {
      if (seenTopicKeys.has(story.topicKey)) continue;
      seenTopicKeys.add(story.topicKey);
    }

    seen.add(uniqueKey);
    merged.push(story);
  }

  return merged;
}

/**
 * Calculate next update time (10x daily: 7am, 9am, 10am, 12pm–4pm, 6pm, 8pm EST)
 */
function getNextUpdateTime(): string {
  const now = new Date();
  const estTime = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  const hour = estTime.getHours();
  const updateHours = [7, 9, 10, 12, 13, 14, 15, 16, 18, 20];

  for (const updateHour of updateHours) {
    if (hour < updateHour) {
      const nextUpdate = new Date(estTime);
      nextUpdate.setHours(updateHour, 0, 0, 0);
      return nextUpdate.toISOString();
    }
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(7, 0, 0, 0);
  return tomorrow.toISOString();
}
