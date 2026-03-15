import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import {
  fetchFinnhubNews,
  fetchNewsAPIMultiple,
  filterByRelevance,
  filterByAge,
  deduplicateNews,
  groupRelatedArticles,
  hasQualitySource,
} from "@/lib/news";
import { synthesizeGroupedArticles } from "@/lib/news-synthesis";
import { NewsCollection, ArchivedNewsCollection, NewsItem } from "@/lib/news-types";
import {
  validateCoPublication,
  CO_PUB_WINDOW_HOURS,
} from "@/lib/co-publication-validator";
import { fetchRSSFeeds, RssFetchStats } from "@/lib/rss-fetch";
import {
  fetchMarketauxNews,
  fetchNewsDataNews,
  fetchGNewsNews,
} from "@/lib/news-apis";

export const maxDuration = 60; // Vercel Pro: up to 60s (synthesis takes 25-50s)
export const runtime = "nodejs";

const RETENTION_DAYS = 30;

// Per-topic cooldown windows (hours) — prevents re-synthesizing the same topic.
// Core macro clusters now use 24h windows to reduce repetitive Fed/inflation/GDP coverage.
const TOPIC_DEDUP_HOURS: Record<string, number> = {
  federal_reserve: 24,  // was 8 — core macro cluster: suppress for 24h
  fed_macro:       24,  // was 8
  inflation:       24,  // was 8
  gdp:             24,  // was 12
  employment:      12,  // was 8
  bond_market:     12,  // was 6
  trade_policy:    12,  // was 6
  energy:          12,  // was 6
  broad_market:    4,   // unchanged — market moves update frequently
  crypto:          4,   // unchanged
  earnings:        4,   // unchanged — company stories refresh faster
  merger_acquisition: 12, // was 8
  bankruptcy:      24,  // was 12
};
const DEFAULT_DEDUP_HOURS = 8; // was 6

/**
 * How long (hours) to suppress a topic after a synthesis rejection.
 * Prevents re-spending Anthropic API credits on groups that already failed
 * fact-check, confidence, or QA in a recent run. Topics re-enter eligibility
 * automatically once the cooldown expires, allowing changed news cycles to
 * produce a different (potentially publishable) synthesis on retry.
 */
const SYNTHESIS_FAILURE_COOLDOWN_HOURS = 4;

// Per-category cap per run — prevents 3 macro stories when only 1 event happened
const PER_CATEGORY_CAP: Record<string, number> = {
  macro: 2,
  earnings: 3,
  markets: 2,
  policy: 2,
  crypto: 2,
  other: 2,
};

const MIN_IMPORTANCE = 8;               // Multi-source groups must meet this floor
const MIN_IMPORTANCE_SINGLE_SOURCE = 6; // Single-source fallback has a lower floor
const MAX_GROUPS_PER_RUN = 3;           // 3 groups × ~15s each + sleeps ≈ 50s, safely under 60s maxDuration
const MAX_GROUPS_FALLBACK = 2;          // Fewer groups when running in single-source fallback mode
/**
 * Rebuild mode — set REBUILD_MODE=true in Vercel env vars to bootstrap an empty feed.
 * Requirements: ≥2 quality stories (not 3), publish cap = 2, detailed rejection logging.
 * Remove REBUILD_MODE once the feed has ≥3 published articles.
 */
const REBUILD_MODE = process.env.REBUILD_MODE === "true";

const MIN_STORIES_TO_PUBLISH = REBUILD_MODE ? 2 : 3; // Publish Decision Layer threshold
const MAX_ARTICLES_PER_DAY = 5;                       // Editorial daily publishing cap

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
  optional: Record<string, boolean>;
}

function healthCheck(): HealthStatus {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Required — pipeline cannot run without these
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.KV_REST_API_URL) missing.push("KV_REST_API_URL");
  if (!process.env.KV_REST_API_TOKEN) missing.push("KV_REST_API_TOKEN");
  if (!process.env.FETCH_NEWS_SECRET) missing.push("FETCH_NEWS_SECRET");

  // Conditionally required — each degrades one feature
  if (!process.env.FINNHUB_API_KEY) warnings.push("FINNHUB_API_KEY not set — Finnhub source disabled");
  if (!process.env.NEWSAPI_API_KEY) warnings.push("NEWSAPI_API_KEY not set — NewsAPI source disabled");
  if (!process.env.UNSPLASH_ACCESS_KEY) warnings.push("UNSPLASH_ACCESS_KEY not set — using fallback images");
  // RSS feeds are always attempted (no API key required) — individual feed failures are non-fatal

  // Optional enrichment API keys — presence/absence logged for diagnostics
  const optional: Record<string, boolean> = {
    FRED_API_KEY:          !!process.env.FRED_API_KEY,
    BLS_API_KEY:           !!process.env.BLS_API_KEY,
    EIA_API_KEY:           !!process.env.EIA_API_KEY,
    FMP_API_KEY:           !!process.env.FMP_API_KEY,
    ALPHAVANTAGE_API_KEY:  !!process.env.ALPHAVANTAGE_API_KEY,
    POLYGON_API_KEY:       !!process.env.POLYGON_API_KEY,
    NEXT_PUBLIC_SITE_URL:  !!process.env.NEXT_PUBLIC_SITE_URL,
    // Extended news sources — each degrades gracefully when absent
    MARKETAUX_API_KEY:     !!process.env.MARKETAUX_API_KEY,
    NEWSDATA_API_KEY:      !!process.env.NEWSDATA_API_KEY,
    GNEWS_API_KEY:         !!process.env.GNEWS_API_KEY,
  };

  const status =
    missing.length > 0 ? "critical" : warnings.length > 0 ? "degraded" : "healthy";

  return { status, missing, warnings, optional };
}

// ---------------------------------------------------------------------------
// GET /api/fetch-news — health check (no token) OR manual trigger (with token)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const token = request.headers.get("x-fetch-news-token");
  const expectedToken = process.env.FETCH_NEWS_SECRET;

  // No token → return health/env-var status only (safe, no secret values exposed)
  if (!token || token !== expectedToken) {
    const health = healthCheck();
    return NextResponse.json(
      {
        health: health.status,
        required: {
          set: ["ANTHROPIC_API_KEY", "KV_REST_API_URL", "KV_REST_API_TOKEN", "FETCH_NEWS_SECRET"].filter(
            (k) => !health.missing.includes(k)
          ),
          missing: health.missing,
        },
        optional: health.optional,
        warnings: health.warnings,
      },
      { status: health.missing.length > 0 ? 503 : 200 }
    );
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

  if (REBUILD_MODE) {
    console.log(
      "[fetch-news] REBUILD MODE ACTIVE — min_publish=2, article_cap=2, qa_threshold=78, " +
      "confidence_threshold=0.58, chart soft-fail=6/10. " +
      "Remove REBUILD_MODE env var once feed has ≥3 articles."
    );
  }

  const stats = {
    fetchedFinnhub: 0,
    fetchedNewsAPI: 0,
    fetchedRSS: 0,
    rssFeedsOk: 0,
    rssFeedsFailed: 0,
    fetchedMarketaux: 0,
    fetchedNewsData: 0,
    fetchedGNews: 0,
    filtered: 0,
    deduplicated: 0,
    grouped: 0,
    crossRunSuppressed: 0,
    tierCheckDropped: 0,
    categoryCapDropped: 0,
    importanceDropped: 0,
    synthesisGroups: 0,
    posted: 0,
    rejected: 0,
    preRejected: 0,       // Groups rejected before Claude synthesis (story worthiness gate)
    archived: 0,
    errors: 0,
    executionMs: 0,
    publishDecision: "pending" as "pending" | "published" | "skipped" | "insufficient",
    storiesWithWhyMatters: 0,
    storiesWithKeyData: 0,
    rebuildMode: REBUILD_MODE,
    rejectionDetails: [] as string[],  // Per-story rejection reasons for diagnostics
    rssFeedStats: null as RssFetchStats | null,
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

    // 1. Fetch from all sources in parallel.
    //    All six sources run concurrently — total wall-clock time ≈ slowest single source.
    //    Each source is fully isolated: one failure returns [] and never aborts the others.
    const [
      finnhubArticles,
      newsapiArticles,
      rssResult,
      marketauxArticles,
      newsdataArticles,
      gnewsArticles,
    ] = await Promise.all([
      fetchFinnhubNews(process.env.FINNHUB_API_KEY || ""),
      fetchNewsAPIMultiple(process.env.NEWSAPI_API_KEY || ""),
      fetchRSSFeeds(),                                              // no API key required
      fetchMarketauxNews(process.env.MARKETAUX_API_KEY || ""),
      fetchNewsDataNews(process.env.NEWSDATA_API_KEY || ""),
      fetchGNewsNews(process.env.GNEWS_API_KEY || ""),
    ]);

    stats.fetchedFinnhub  = finnhubArticles.length;
    stats.fetchedNewsAPI  = newsapiArticles.length;
    stats.fetchedRSS      = rssResult.articles.length;
    stats.rssFeedsOk      = rssResult.stats.feedsSucceeded;
    stats.rssFeedsFailed  = rssResult.stats.feedsFailed;
    stats.rssFeedStats    = rssResult.stats;
    stats.fetchedMarketaux = marketauxArticles.length;
    stats.fetchedNewsData  = newsdataArticles.length;
    stats.fetchedGNews     = gnewsArticles.length;

    const totalFetched =
      finnhubArticles.length + newsapiArticles.length + rssResult.articles.length +
      marketauxArticles.length + newsdataArticles.length + gnewsArticles.length;

    console.log(
      `[fetch-news] Fetched ${totalFetched} total articles — ` +
      `Finnhub=${finnhubArticles.length}, NewsAPI=${newsapiArticles.length}, ` +
      `RSS=${rssResult.articles.length} (${rssResult.stats.feedsSucceeded}/${rssResult.stats.feedsAttempted} feeds), ` +
      `Marketaux=${marketauxArticles.length}, NewsData=${newsdataArticles.length}, GNews=${gnewsArticles.length}`
    );

    // 2. Combine all sources into one pool, then age-filter and relevance-filter.
    //    All six sources are treated identically from this point forward — there is
    //    no source-specific branching in deduplication, grouping, or synthesis.
    const allArticles = [
      ...finnhubArticles,
      ...newsapiArticles,
      ...rssResult.articles,
      ...marketauxArticles,
      ...newsdataArticles,
      ...gnewsArticles,
    ];
    const fresh = filterByAge(allArticles, 48);
    const relevant = filterByRelevance(fresh);
    stats.filtered = relevant.length;

    console.log(`[fetch-news] After age filter (48h): ${fresh.length} articles (${allArticles.length - fresh.length} dropped as stale)`);
    console.log(`[fetch-news] After relevance filter: ${relevant.length} articles (${fresh.length - relevant.length} dropped as irrelevant)`);

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
    stats.grouped = grouped.length;
    console.log(`[fetch-news] Grouped into ${grouped.length} topic groups`);

    // 4a. Prefer multi-source groups (2+ articles); fall back to single-source
    //     if none are available. The importance scorer already favors multi-source
    //     stories via multiSourceScore, so quality is maintained downstream.
    const multiSourceGroups = grouped.filter((g) => g.articles.length >= 2);
    const singleSourceGroups = grouped.filter((g) => g.articles.length === 1);

    console.log(
      `[fetch-news] ${multiSourceGroups.length} multi-source groups, ` +
      `${singleSourceGroups.length} single-source groups`
    );

    let qualifiedGroups: typeof grouped;
    let usingFallback = false;

    if (multiSourceGroups.length > 0) {
      qualifiedGroups = multiSourceGroups;
      console.log(`[fetch-news] Using multi-source path (${multiSourceGroups.length} groups)`);
    } else if (singleSourceGroups.length > 0) {
      qualifiedGroups = singleSourceGroups;
      usingFallback = true;
      console.log(
        `[fetch-news] No multi-source groups — falling back to single-source path ` +
        `(${singleSourceGroups.length} groups, importance floor=${MIN_IMPORTANCE_SINGLE_SOURCE})`
      );
    } else {
      console.warn("[fetch-news] No groups found — skipping synthesis this run");
      return NextResponse.json({ message: "No groups found after dedup", stats, health: health.warnings });
    }

    // 4b. LOAD existing stories early — needed for cross-run topic dedup and daily cap
    const { active: existingActive } = await loadNewsWithArchival(kv);

    // 4b.0. Load topics that recently failed synthesis (within SYNTHESIS_FAILURE_COOLDOWN_HOURS).
    //   These are suppressed in 4c alongside published-topic cooldowns so that the
    //   same already-known-failing groups don't consume Claude synthesis budget every run.
    const recentSynthesisFailures = await loadSynthesisFailures(kv);
    if (recentSynthesisFailures.size > 0) {
      console.log(
        `[fetch-news] Synthesis-failure cooldown active for: [${[...recentSynthesisFailures].join(", ")}]`
      );
    }

    // 4b.1. Daily publishing cap — count stories already published today (UTC date)
    const todayUTC = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const storiesPublishedToday = existingActive.filter((s) =>
      s.publishedAt.startsWith(todayUTC)
    ).length;
    const remainingDailyBudget = Math.max(0, MAX_ARTICLES_PER_DAY - storiesPublishedToday);

    console.log(
      `[fetch-news] Daily budget: ${storiesPublishedToday}/${MAX_ARTICLES_PER_DAY} articles published today, ` +
      `${remainingDailyBudget} remaining`
    );

    if (remainingDailyBudget === 0) {
      stats.publishDecision = "skipped";
      stats.executionMs = Date.now() - startTime;
      console.log(`[fetch-news] Daily cap reached — skipping synthesis`);
      return NextResponse.json({
        success: true,
        message: `Daily publishing cap reached (${MAX_ARTICLES_PER_DAY} articles already published today)`,
        stats,
        health: health.warnings,
      });
    }

    // 4c. Cross-run topic dedup — skip topics covered within their cooldown window
    const recentTopics = extractRecentTopicKeys(existingActive, TOPIC_DEDUP_HOURS, DEFAULT_DEDUP_HOURS);
    console.log(`[fetch-news] Recently covered topics (within cooldown): [${[...recentTopics].join(", ")}]`);

    const afterCrossRunDedup = qualifiedGroups.filter((g) => {
      if (recentTopics.has(g.topic)) {
        console.log(`[fetch-news] Cross-run suppressed: "${g.topic}" (covered within cooldown window)`);
        return false;
      }
      if (recentSynthesisFailures.has(g.topic)) {
        console.log(
          `[fetch-news] Synthesis-failure suppressed: "${g.topic}" ` +
          `(failed synthesis within ${SYNTHESIS_FAILURE_COOLDOWN_HOURS}h — skipping to save API credits)`
        );
        return false;
      }
      return true;
    });
    stats.crossRunSuppressed = qualifiedGroups.length - afterCrossRunDedup.length;

    // 4c.5. Tier-1 source filter — require at least one Tier 1 or Tier 2 source per group
    const tierCheckBefore = afterCrossRunDedup.length;
    const afterTierCheck = afterCrossRunDedup.filter((g) => {
      if (!hasQualitySource(g.articles)) {
        console.log(`[fetch-news] Tier check: dropping "${g.topic}" (no Tier 1/2 source among ${g.articles.length} articles)`);
        return false;
      }
      return true;
    });

    stats.tierCheckDropped = tierCheckBefore - afterTierCheck.length;

    if (afterTierCheck.length === 0 && afterCrossRunDedup.length > 0) {
      // All groups dropped by tier check — log clearly so we know why
      console.warn(
        `[fetch-news] All ${afterCrossRunDedup.length} groups failed tier check — ` +
        `no Tier 1/2 sources found. Skipping synthesis this run.`
      );
      return NextResponse.json({
        message: "No groups with quality Tier 1/2 sources — synthesis skipped",
        stats,
        health: health.warnings,
      });
    }

    // 4d. Per-category cap
    const categoryCount: Record<string, number> = {};
    const catCapBefore = afterTierCheck.length;
    const afterCategoryCap = afterTierCheck.filter((g) => {
      const cat = g.category;
      categoryCount[cat] = (categoryCount[cat] ?? 0) + 1;
      const cap = PER_CATEGORY_CAP[cat] ?? 2;
      if (categoryCount[cat] > cap) {
        console.log(`[fetch-news] Category cap: dropping "${g.topic}" (${cat} already at ${cap})`);
        return false;
      }
      return true;
    });
    stats.categoryCapDropped = catCapBefore - afterCategoryCap.length;

    // 4e. Minimum importance floor (lower in single-source fallback mode)
    const impBefore = afterCategoryCap.length;
    const importanceFloor = usingFallback ? MIN_IMPORTANCE_SINGLE_SOURCE : MIN_IMPORTANCE;
    const afterImportanceFloor = afterCategoryCap.filter((g) => {
      if (g.importance < importanceFloor) {
        console.log(`[fetch-news] Low importance: dropping "${g.topic}" (score=${g.importance} < floor=${importanceFloor})`);
        return false;
      }
      return true;
    });

    // 4f. Cap total groups per run — respects both mode cap and daily budget
    const modeCap = usingFallback ? MAX_GROUPS_FALLBACK : MAX_GROUPS_PER_RUN;
    const groupCap = Math.min(modeCap, remainingDailyBudget);
    stats.importanceDropped = impBefore - afterImportanceFloor.length;
    const groupsToSynthesize = afterImportanceFloor.slice(0, groupCap);
    stats.synthesisGroups = groupsToSynthesize.length;

    console.log(
      `[fetch-news] Pipeline stage counts — ` +
      `grouped=${stats.grouped}, crossRunSuppressed=${stats.crossRunSuppressed}, ` +
      `tierDropped=${stats.tierCheckDropped}, catCapDropped=${stats.categoryCapDropped}, ` +
      `importanceDropped=${stats.importanceDropped}, toSynthesize=${stats.synthesisGroups}`
    );
    console.log(
      `[fetch-news] Final groups to synthesize: ${groupsToSynthesize.length} ` +
      `(mode=${usingFallback ? "single-source-fallback" : "multi-source"}, ` +
      `cap=${groupCap}, cross-run suppressed=${stats.crossRunSuppressed}, ` +
      `rebuild=${REBUILD_MODE})`
    );

    if (groupsToSynthesize.length === 0) {
      console.warn("[fetch-news] No groups remain after filters — skipping synthesis this run");
      return NextResponse.json({ message: "All topics recently covered or below quality threshold", stats, health: health.warnings });
    }

    // 5. Synthesize with Claude
    // Pass existingActive so the synthesis can:
    //   (a) prevent duplicate images vs. the current feed
    //   (b) run the editorial QA gate against the full existing context
    console.log(`[fetch-news] Starting synthesis on ${groupsToSynthesize.length} groups`);
    const { stories, stats: synthStats } = await synthesizeGroupedArticles(groupsToSynthesize, existingActive);
    stats.posted = synthStats.posted;
    stats.rejected = synthStats.rejected;
    stats.preRejected = synthStats.preRejected ?? 0;
    stats.errors = synthStats.errors;
    stats.rejectionDetails = synthStats.rejectionDetails ?? [];

    console.log(
      `[fetch-news] Synthesis complete [${REBUILD_MODE ? "REBUILD" : "PRODUCTION"}]: ` +
      `synthesisGroups=${stats.synthesisGroups}, preRejected=${stats.preRejected}, ` +
      `posted=${synthStats.posted}, rejected=${synthStats.rejected}, errors=${synthStats.errors}`
    );

    // 5a-pre. Write synthesis-failure cooldowns to Redis
    // Any topic that failed fact-check, confidence, or QA in this run is recorded
    // so the next run's cross-run dedup (step 4c) can skip it before calling Claude.
    const rejectedTopicKeys = synthStats.rejectedTopics ?? [];
    if (rejectedTopicKeys.length > 0) {
      try {
        const failures: Record<string, string> = {};
        const now = new Date().toISOString();
        for (const topic of rejectedTopicKeys) {
          failures[topic] = now;
        }
        await kv.hset("news-synthesis-failures", failures);
        // TTL = 2× the cooldown window so timestamps have room to age out naturally
        await kv.expire("news-synthesis-failures", SYNTHESIS_FAILURE_COOLDOWN_HOURS * 2 * 60 * 60);
        console.log(
          `[fetch-news] Synthesis-failure cooldown set for: [${rejectedTopicKeys.join(", ")}] ` +
          `(suppressed for ${SYNTHESIS_FAILURE_COOLDOWN_HOURS}h)`
        );
      } catch (err) {
        // Non-fatal: worst case next run re-attempts synthesis on these topics
        console.warn("[fetch-news] Failed to write synthesis failures to Redis:", err);
      }
    }

    // 5b. Co-publication validation
    // Runs when ≥1 story is ready to publish. Checks the incoming batch against
    // each other AND against any stories already published within CO_PUB_WINDOW_HOURS.
    // Stories outside that window (evolving coverage) are never affected.
    let publishCandidates: NewsItem[] = stories;

    if (stories.length > 0) {
      const windowMs = CO_PUB_WINDOW_HOURS * 60 * 60 * 1000;
      const recentlyPublished = existingActive.filter((s) => {
        const ageMs = Date.now() - new Date(s.publishedAt).getTime();
        return ageMs < windowMs;
      });

      const coValidation = validateCoPublication(stories, recentlyPublished);

      if (coValidation.issues.length > 0) {
        for (const issue of coValidation.issues) {
          console.log(
            `[co-pub-validator] ${issue.severity.toUpperCase()} [${issue.type}] ${issue.description}`
          );
        }
      }

      if (coValidation.rejectedIds.length > 0) {
        publishCandidates = stories.filter(
          (s) => !coValidation.rejectedIds.includes(s.id)
        );
        const coRejectionReasons = coValidation.issues
          .filter((i) => i.severity === "reject")
          .map((i) => `co-pub [${i.type}]: ${i.description.substring(0, 140)}`);
        stats.rejectionDetails.push(...coRejectionReasons);
        stats.rejected += coValidation.rejectedIds.length;
        stats.posted = Math.max(0, stats.posted - coValidation.rejectedIds.length);
        console.log(
          `[co-pub-validator] Removed ${coValidation.rejectedIds.length} story(ies) from publish batch ` +
          `(${publishCandidates.length} remain). Rejected: [${coValidation.rejectedIds.join(", ")}]`
        );
      } else if (coValidation.warningIds.length > 0) {
        console.log(
          `[co-pub-validator] ${coValidation.warningIds.length} warning(s) — stories will publish with logged notice`
        );
      } else if (stories.length > 0) {
        console.log(
          `[co-pub-validator] All ${stories.length} candidate(s) passed co-publication checks`
        );
      }
    }

    // 5c. Publish Decision Layer
    // Bootstrap (empty feed): require ≥MIN_STORIES_TO_PUBLISH for a quality initial batch.
    // Ongoing (feed has content): publish with ≥1 new story — the 3-story gate is only
    //   meaningful for first-run quality; subsequent hourly runs often produce 1-2 stories
    //   due to cross-run topic dedup windows, so blocking them prevents any updates.
    const qualityStories = publishCandidates.filter(
      (s) => s.whyThisMatters && s.whyThisMatters.length > 10
    );
    stats.storiesWithWhyMatters = qualityStories.length;
    stats.storiesWithKeyData = publishCandidates.filter((s) => (s.keyDataPoints?.length ?? 0) > 0).length;

    const feedIsEmpty = existingActive.length === 0;
    // Bootstrap: need MIN_STORIES_TO_PUBLISH. Ongoing: any new story is publishable.
    const meetsThreshold = feedIsEmpty
      ? publishCandidates.length >= MIN_STORIES_TO_PUBLISH
      : publishCandidates.length >= 1;

    if (!meetsThreshold) {
      stats.publishDecision = "insufficient";
      stats.executionMs = Date.now() - startTime;
      console.warn(
        `[fetch-news] Publish decision: INSUFFICIENT — ${publishCandidates.length} new stories after co-pub validation ` +
        (feedIsEmpty
          ? `(bootstrap requires ${MIN_STORIES_TO_PUBLISH} for a quality initial feed, ` +
            `${REBUILD_MODE ? "rebuild" : "production"} mode). ` +
            (!REBUILD_MODE ? "Set REBUILD_MODE=true in Vercel env to lower thresholds." : "Check [synthesis] logs above.")
          : `(ongoing run; need ≥1 synthesized story to publish).`)
      );
      return NextResponse.json({
        success: true,
        message:
          feedIsEmpty
            ? `Only ${publishCandidates.length} new stories synthesized — bootstrap threshold not met (need ${MIN_STORIES_TO_PUBLISH}). ` +
              (!REBUILD_MODE ? "Hint: set REBUILD_MODE=true to lower thresholds." : "")
            : `No new stories synthesized this run — existing feed preserved.`,
        stats,
        health: health.warnings,
      });
    }
    stats.publishDecision = "published";
    if (feedIsEmpty) {
      console.log(
        `[fetch-news] Publish decision: BOOTSTRAP PUBLISH — ${publishCandidates.length} story(ies) ` +
        `(feed was empty; bootstrap threshold met)`
      );
    }
    console.log(
      `[fetch-news] Publish decision: PUBLISH — ${publishCandidates.length} new stories ` +
      `(${stats.storiesWithWhyMatters} with why-matters, ${stats.storiesWithKeyData} with key data, ` +
      `rebuild=${REBUILD_MODE})`
    );

    // 5a. Write newly covered topics to Redis for cross-run memory
    if (publishCandidates.length > 0) {
      const topicUpdates: Record<string, string> = {};
      for (const story of publishCandidates) {
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
    const allStories = mergeNewsWithDedup([...publishCandidates, ...existingActive]);

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
      source: "Market Mountain Financial Newswire",
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
    if (publishCandidates.length > 0 && stats.posted > 0) {
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

    const totalArticlesFetched =
      stats.fetchedFinnhub + stats.fetchedNewsAPI + stats.fetchedRSS +
      stats.fetchedMarketaux + stats.fetchedNewsData + stats.fetchedGNews;

    return NextResponse.json({
      success: true,
      message:
        `Fetched ${totalArticlesFetched} articles ` +
        `(Finnhub=${stats.fetchedFinnhub}, NewsAPI=${stats.fetchedNewsAPI}, ` +
        `RSS=${stats.fetchedRSS}/${stats.rssFeedsOk + stats.rssFeedsFailed} feeds, ` +
        `Marketaux=${stats.fetchedMarketaux}, NewsData=${stats.fetchedNewsData}, GNews=${stats.fetchedGNews}), ` +
        `posted ${stats.posted} stories`,
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
      // Strip archivedAt so the returned objects match the NewsItem shape.
      // `_stripped` is explicitly voided to satisfy no-unused-vars.
      archived = data.archivedNews?.map((s) => {
        const { archivedAt: _stripped, ...item } = s;
        void _stripped;
        return item;
      }) ?? [];
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
 * Load the set of topic keys that failed synthesis (fact-check / confidence / QA)
 * within the past SYNTHESIS_FAILURE_COOLDOWN_HOURS. Used to suppress re-synthesis
 * of groups that are already known to fail, saving Anthropic API credits.
 *
 * Stored in Redis as `news-synthesis-failures` hash: topicKey → ISO timestamp.
 */
async function loadSynthesisFailures(
  kv: Redis,
  cooldownHours: number = SYNTHESIS_FAILURE_COOLDOWN_HOURS
): Promise<Set<string>> {
  const failures = new Set<string>();
  try {
    const data = await kv.hgetall("news-synthesis-failures") as Record<string, string> | null;
    if (!data) return failures;
    const windowMs = cooldownHours * 60 * 60 * 1000;
    const now = Date.now();
    for (const [topic, timestamp] of Object.entries(data)) {
      const age = now - new Date(timestamp).getTime();
      if (age < windowMs) {
        failures.add(topic);
      }
    }
  } catch (err) {
    // Non-fatal: worst case we re-attempt synthesis on an already-known-failing group
    console.warn("[fetch-news] Failed to load synthesis failures from Redis:", err);
  }
  return failures;
}

/**
 * Calculate next update time (hourly 7AM–9PM ET).
 */
function getNextUpdateTime(): string {
  const now = new Date();
  const estOffset = -4; // Use EDT (UTC-4) as conservative estimate; -5 in winter is fine to approximate
  const estHour = (now.getUTCHours() + 24 + estOffset) % 24;
  const estMinute = now.getUTCMinutes();

  // Find next whole hour within 7AM–9PM ET window
  let nextHour = estMinute > 0 ? estHour + 1 : estHour; // current hour if on the dot, else next
  if (nextHour > estHour) {
    // Next hour is within today
    if (nextHour >= 7 && nextHour <= 21) {
      const next = new Date(now);
      next.setUTCHours(now.getUTCHours() + (nextHour - estHour), 0, 0, 0);
      return next.toISOString();
    }
  }

  // Outside operating window — next run is 7AM ET tomorrow
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(7 - estOffset, 0, 0, 0); // 7AM ET = 11 UTC (EDT) or 12 UTC (EST)
  return tomorrow.toISOString();
}
