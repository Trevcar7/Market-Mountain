import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import type { Redis } from "@upstash/redis";
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
import { detectMarketRegime, applyRegimeBoosts } from "@/lib/market-regime";
import { SUPPRESSED_ARTICLE_IDS } from "@/lib/suppressed-articles";

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
  // Geopolitics: 24h window — geopolitical events (Middle East, Russia, China tensions)
  // tend to produce a burst of overlapping articles; suppress to 1 synthesis per day.
  geopolitics:     24,
};
const DEFAULT_DEDUP_HOURS = 8; // was 6

// ---------------------------------------------------------------------------
// Entity-based event matching — prevents duplicate articles on the same
// ongoing story when different topic keys surface the same real-world event.
//
// Example: "energy" + "geopolitics" + "inflation" all spawned for the same
// Iran tensions → oil spike event. Standard topic dedup can't catch this
// because they have different topic keys. Entity matching does.
//
// Ongoing event window: how far back to look for entity-matching articles.
// Stories covering Iran, oil, AND Middle East in the same 72h window are
// treated as the same ongoing story and suppressed (only the first wins).
// ---------------------------------------------------------------------------
const ONGOING_EVENT_WINDOW_HOURS = 72;
const ENTITY_OVERLAP_THRESHOLD = 0.55; // 55% shared entities = same ongoing story
const HEADLINE_SIMILARITY_THRESHOLD = 0.50; // 50% word overlap = likely same story

/**
 * Extract a normalized set of key entities from a collection of text strings.
 * Covers geopolitical actors, commodities, financial instruments, and major
 * companies. Designed for fast overlap detection without external dependencies.
 */
function extractEventEntities(texts: string[]): Set<string> {
  const combined = texts.join(" ").toLowerCase();
  const entities = new Set<string>();

  // Geopolitical actors that commonly drive correlated market stories
  const GEO_ACTORS = [
    "iran", "russia", "china", "ukraine", "israel", "taiwan",
    "opec", "saudi", "middle east", "persian gulf", "red sea",
    "nato", "europe", "eu", "japan", "korea",
  ];
  for (const actor of GEO_ACTORS) {
    if (combined.includes(actor)) entities.add(actor);
  }

  // Commodities — price moves in these often create correlated macro articles
  const COMMODITIES = [
    "oil", "crude", "wti", "brent", "natural gas", "lng",
    "gold", "silver", "copper", "wheat", "corn",
  ];
  for (const c of COMMODITIES) {
    if (combined.includes(c)) entities.add(c);
  }

  // Crypto assets — prevent "bitcoin" articles from spawning across topic keys
  const CRYPTO_ASSETS = ["bitcoin", "btc", "ethereum", "eth", "crypto", "blockchain"];
  for (const c of CRYPTO_ASSETS) {
    if (combined.includes(c)) entities.add(c);
  }

  // Macro events — central bank actions, regulatory moves, economic data
  const MACRO_EVENTS = [
    "federal reserve", "fed", "rate cut", "rate hike", "interest rate",
    "inflation", "cpi", "pce", "gdp", "unemployment", "jobs",
    "tariff", "sanction", "treasury", "yield",
  ];
  for (const e of MACRO_EVENTS) {
    if (combined.includes(e)) entities.add(e);
  }

  // Major companies (add only if explicitly named — avoids false positives)
  const MAJOR_COS = [
    "nvidia", "apple", "microsoft", "tesla", "amazon",
    "alphabet", "meta", "jpmorgan", "berkshire", "goldman",
    "boeing", "exxon", "chevron", "shell",
  ];
  for (const co of MAJOR_COS) {
    if (new RegExp(`\\b${co}\\b`).test(combined)) entities.add(co);
  }

  return entities;
}

/**
 * Compute entity overlap as a Jaccard-style coefficient (0–1).
 * Returns the ratio of shared entities to the smaller set size,
 * so a small group matching all its entities to a large group scores 1.0.
 */
function computeEntityOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((e) => b.has(e)).length;
  return intersection / Math.min(a.size, b.size);
}

/**
 * Compute headline similarity as a word-level Jaccard coefficient.
 * Stops words (the, a, and, in, of, etc.) are excluded to focus on
 * meaningful content words. Returns 0–1 where 1.0 = identical headlines.
 *
 * This catches near-duplicate headlines that entity matching may miss
 * (e.g. "Oil Prices Rise on Iran Tensions" vs "Iran Tensions Push Oil Higher").
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "that",
  "this", "these", "those", "it", "its", "not", "no", "nor", "so",
  "yet", "both", "each", "all", "any", "more", "most", "other", "some",
  "such", "than", "too", "very", "just", "also", "amid", "after",
  "before", "between", "during", "into", "over", "under", "about",
]);

function computeHeadlineSimilarity(headline1: string, headline2: string): number {
  const tokenize = (s: string): Set<string> => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    return new Set(words.filter((w) => !STOP_WORDS.has(w) && w.length > 1));
  };
  const a = tokenize(headline1);
  const b = tokenize(headline2);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Rebuild mode — set REBUILD_MODE=true in Vercel env vars to bootstrap an empty feed.
 * Requirements: ≥2 quality stories (not 3), publish cap = 2, detailed rejection logging.
 * Remove REBUILD_MODE once the feed has ≥3 published articles.
 */
const REBUILD_MODE = process.env.REBUILD_MODE === "true";

/**
 * How long (hours) to suppress a topic after a synthesis rejection.
 * Prevents re-spending Anthropic API credits on groups that already failed
 * fact-check, confidence, or QA in a recent run. Topics re-enter eligibility
 * automatically once the cooldown expires, allowing changed news cycles to
 * produce a different (potentially publishable) synthesis on retry.
 *
 * Production: 4h | Rebuild: 1h (allows quicker retries after deploying fixes)
 */
const SYNTHESIS_FAILURE_COOLDOWN_HOURS = REBUILD_MODE ? 1 : 4;

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

const MIN_STORIES_TO_PUBLISH = REBUILD_MODE ? 2 : 3; // Publish Decision Layer threshold
const MAX_ARTICLES_PER_DAY = 5;                       // Editorial daily publishing cap

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------


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

  // Also accept Vercel Cron authorization (Bearer CRON_SECRET)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const cronAuthed = cronSecret && authHeader === `Bearer ${cronSecret}`;

  // No valid token → return health/env-var status only (safe, no secret values exposed)
  if (!cronAuthed && (!token || token !== expectedToken)) {
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
    entityMatchSuppressed: 0,  // Groups suppressed because they match an ongoing story
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
    // Strip suppressed articles from the active set so they don't pollute the
    // daily-cap counter, topic-dedup memory, or the merged publish batch.
    const { active: existingActiveRaw } = await loadNewsWithArchival(kv);
    const existingActive = existingActiveRaw.filter(
      (s) => !SUPPRESSED_ARTICLE_IDS.has(s.id)
    );

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

    // 4c.7. Entity-based event matching — "ongoing story" deduplication.
    //
    // Problem: different topic keys can surface the same real-world event.
    // Example: Iran tensions → oil spike spawns "energy" + "geopolitics" +
    // "inflation" articles all in the same run or within hours of each other.
    // Standard topic-key cross-run dedup misses this because the keys differ.
    //
    // Solution: extract key entities (countries, commodities, companies) from
    // each group's article titles and compare them against entities in articles
    // already published within ONGOING_EVENT_WINDOW_HOURS. If entity overlap
    // exceeds ENTITY_OVERLAP_THRESHOLD, the group is "same ongoing story" and
    // is suppressed. Only the first (highest-ranked) group for a given entity
    // cluster gets synthesized.
    //
    // Decision rule (update vs. new):
    //   ≥ ENTITY_OVERLAP_THRESHOLD match within ONGOING_EVENT_WINDOW_HOURS → SUPPRESS
    //     (the existing article already covers this story; a new article would be a
    //     near-duplicate rather than a genuine update)
    //   New entity cluster OR event window expired → SYNTHESIZE as new article
    //
    // Future enhancement: when an exact entity match is found and the existing article
    // is more than 24h old, update its body in-place instead of suppressing entirely.
    // That "living article" update path is a planned extension to this system.
    const windowMs = ONGOING_EVENT_WINDOW_HOURS * 60 * 60 * 1000;
    const recentPublishedArticles = existingActive.filter(
      (s) => Date.now() - new Date(s.publishedAt).getTime() < windowMs
    );

    // Pre-compute entity signatures for existing recent articles
    const existingEntitySigs = recentPublishedArticles.map((article) => ({
      title: article.title,
      topicKey: article.topicKey ?? "",
      entities: extractEventEntities([article.title, article.topicKey ?? ""]),
    }));

    const entityMatchBefore = afterTierCheck.length;
    // Track which entity clusters have already been claimed by a group in this run
    // (prevents TWO new groups in the same run from publishing on the same cluster)
    const claimedEntityClusters: Set<string>[] = [];

    // Also track claimed headlines for in-run headline similarity suppression
    const claimedGroupHeadlines: string[] = [];

    const afterEntityMatch = afterTierCheck.filter((g) => {
      const groupTitles = g.articles.map((a) => {
        const raw = a as Record<string, unknown>;
        return String(raw.headline ?? raw.title ?? "");
      });
      const groupEntities = extractEventEntities([g.topic, ...groupTitles]);
      const compositeHeadline = groupTitles.join(" ");

      // ── Headline similarity check (catches near-dupes entity matching misses) ──
      // Compare group's headlines against recently published article titles.
      for (const sig of existingEntitySigs) {
        const sim = computeHeadlineSimilarity(compositeHeadline, sig.title);
        if (sim >= HEADLINE_SIMILARITY_THRESHOLD) {
          console.log(
            `[fetch-news] Headline-similarity suppress: "${g.topic}" ` +
            `(${Math.round(sim * 100)}% word overlap with published ` +
            `"${sig.title.slice(0, 60)}" [${sig.topicKey}])`
          );
          return false;
        }
      }

      // Check headline similarity against other groups already accepted in this run
      for (const claimed of claimedGroupHeadlines) {
        const sim = computeHeadlineSimilarity(compositeHeadline, claimed);
        if (sim >= HEADLINE_SIMILARITY_THRESHOLD) {
          console.log(
            `[fetch-news] Headline-similarity suppress: "${g.topic}" ` +
            `(${Math.round(sim * 100)}% word overlap with another group in this run)`
          );
          return false;
        }
      }

      // ── Entity-based matching ──
      // Need at least 2 entities to do meaningful matching (1-entity groups are
      // too broad — "oil" alone would match everything in an oil-driven run)
      if (groupEntities.size >= 2) {
        // Check against published articles in the ongoing-event window
        for (const sig of existingEntitySigs) {
          if (sig.entities.size < 2) continue;
          const overlap = computeEntityOverlap(groupEntities, sig.entities);
          if (overlap >= ENTITY_OVERLAP_THRESHOLD) {
            console.log(
              `[fetch-news] Entity-match suppress: "${g.topic}" ` +
              `(${Math.round(overlap * 100)}% entity overlap with published ` +
              `"${sig.title.slice(0, 60)}" [${sig.topicKey}] — same ongoing story)`
            );
            return false;
          }
        }

        // Check against other groups already accepted in this run
        for (const claimedEntities of claimedEntityClusters) {
          if (claimedEntities.size < 2) continue;
          const overlap = computeEntityOverlap(groupEntities, claimedEntities);
          if (overlap >= ENTITY_OVERLAP_THRESHOLD) {
            console.log(
              `[fetch-news] Entity-match suppress: "${g.topic}" ` +
              `(${Math.round(overlap * 100)}% entity overlap with another group in this run — ` +
              `same ongoing story, only first group synthesized)`
            );
            return false;
          }
        }
      }

      // This group's entity cluster is novel — claim it and allow synthesis
      claimedEntityClusters.push(groupEntities);
      claimedGroupHeadlines.push(compositeHeadline);
      return true;
    });

    stats.entityMatchSuppressed = entityMatchBefore - afterEntityMatch.length;

    if (stats.entityMatchSuppressed > 0) {
      console.log(
        `[fetch-news] Entity/headline-match: ${stats.entityMatchSuppressed} group(s) suppressed ` +
        `(same ongoing story or near-duplicate headlines)`
      );
    }

    // 4d. Per-category cap
    const categoryCount: Record<string, number> = {};
    const catCapBefore = afterEntityMatch.length;
    const afterCategoryCap = afterEntityMatch.filter((g) => {
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

    // 4d.5-pre. Market regime detection — boost importance for macro/earnings/geo signals.
    // Applied before the diversification sort so boosted groups rise in priority naturally.
    const regime = detectMarketRegime(
      afterCategoryCap.map((g) => ({
        topic: g.topic,
        articles: g.articles as Array<unknown>,
      }))
    );
    if (regime.activeSignals.length > 0) {
      console.log(`[fetch-news] ${regime.description}`);
      const boostedCount = applyRegimeBoosts(afterCategoryCap, regime, console.log);
      if (boostedCount > 0) {
        console.log(`[fetch-news] Regime boosts applied to ${boostedCount} group(s)`);
      }
    }

    // 4d.5. Diversification promotion — re-sort groups to promote category diversity.
    //
    // Problem: When one macro event dominates (e.g., Iran/oil), all top-importance
    // groups cluster in the same category ("macro" or "policy"). The per-category cap
    // drops excess groups, but they were already the highest-ranked, so we lose good
    // stories while potentially missing distinct sector/earnings angles.
    //
    // Solution: Re-sort groups so that categories already heavily represented in the
    // recent feed (last 24h) are ranked lower, and underrepresented categories get a
    // promotion boost. This does NOT override hard caps — it just changes priority
    // ordering so the 3-group cap picks a diverse mix.
    const recentCategoryHistogram: Record<string, number> = {};
    const dayMs = 24 * 60 * 60 * 1000;
    for (const s of existingActive) {
      if (Date.now() - new Date(s.publishedAt).getTime() < dayMs) {
        const cat = s.category || "other";
        recentCategoryHistogram[cat] = (recentCategoryHistogram[cat] ?? 0) + 1;
      }
    }

    const diversifiedGroups = [...afterCategoryCap].sort((a, b) => {
      const aCatCount = recentCategoryHistogram[a.category] ?? 0;
      const bCatCount = recentCategoryHistogram[b.category] ?? 0;

      // Diversification bonus: groups in underrepresented categories get priority.
      // Each existing article in the same category reduces the group's effective
      // importance by 2 points, making room for different angles.
      const aEffective = a.importance - (aCatCount * 2);
      const bEffective = b.importance - (bCatCount * 2);

      // Primary sort: effective importance (higher first)
      if (bEffective !== aEffective) return bEffective - aEffective;
      // Tie-break: raw importance
      return b.importance - a.importance;
    });

    if (Object.keys(recentCategoryHistogram).length > 0) {
      console.log(
        `[fetch-news] Diversification: recent 24h categories = ${JSON.stringify(recentCategoryHistogram)}. ` +
        `Re-sorted ${diversifiedGroups.length} groups to promote underrepresented categories.`
      );
    }

    // 4e. Minimum importance floor (lower in single-source fallback mode)
    const impBefore = diversifiedGroups.length;
    const importanceFloor = usingFallback ? MIN_IMPORTANCE_SINGLE_SOURCE : MIN_IMPORTANCE;
    const afterImportanceFloor = diversifiedGroups.filter((g) => {
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
      `entityMatchSuppressed=${stats.entityMatchSuppressed}, ` +
      `tierDropped=${stats.tierCheckDropped}, catCapDropped=${stats.categoryCapDropped}, ` +
      `importanceDropped=${stats.importanceDropped}, toSynthesize=${stats.synthesisGroups}`
    );
    console.log(
      `[fetch-news] Final groups to synthesize: ${groupsToSynthesize.length} ` +
      `(mode=${usingFallback ? "single-source-fallback" : "multi-source"}, ` +
      `cap=${groupCap}, cross-run suppressed=${stats.crossRunSuppressed}, ` +
      `entity-match suppressed=${stats.entityMatchSuppressed}, ` +
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
