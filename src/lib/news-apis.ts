/**
 * Extended News API Fetchers — Marketaux, NewsData.io, GNews
 *
 * Each function fetches from one provider, normalizes the response into the
 * same FinnhubArticle shape used throughout the pipeline, and returns an empty
 * array on any error so the pipeline always continues with the remaining sources.
 *
 * Normalization strategy:
 *   - headline  → article title
 *   - summary   → description (truncated to 400 chars to avoid giant blobs)
 *   - url       → canonical article URL
 *   - source    → original outlet name (e.g. "Reuters", "CNBC") — NOT the
 *                 aggregator name. This is critical: the existing TIER_1_SOURCES /
 *                 TIER_2_SOURCES matching in news.ts works on the outlet name,
 *                 so a Reuters article surfaced via Marketaux still gets Tier 1 weight.
 *   - datetime  → Unix timestamp in seconds (matches FinnhubArticle convention)
 *   - image     → thumbnail URL if available
 *   - related   → equity tickers from entity extraction (Marketaux only)
 *                 or author encoded as "author:<name>" (NewsData/GNews)
 *
 * Error handling:
 *   - Missing API key → warn + return []  (graceful opt-out)
 *   - HTTP error      → log status + return []
 *   - API-level error → log message + return []
 *   - Network failure → log + return []
 *   Each provider is fully isolated — one failure never affects the others.
 */

import { FinnhubArticle } from "./news-types";

const FETCH_TIMEOUT_MS = 10_000;

/** Abort-controlled fetch with timeout. Throws on timeout or network error. */
async function timedFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "Accept": "application/json" },
    });
  } finally {
    clearTimeout(id);
  }
}

// ── Marketaux ─────────────────────────────────────────────────────────────────
// Documentation: https://www.marketaux.com/documentation
// Free tier: 100 requests/day, up to 50 articles per request.
// The API surfaces financial news with entity extraction (tickers, sentiment).
// Using filter_entities=true ensures articles are explicitly linked to publicly
// traded companies — keeps relevance high without needing keyword filtering.

interface MarketauxEntity {
  symbol?: string;
  type?: string;     // "equity", "index", "crypto", etc.
  industry?: string;
  sentiment_score?: number;
}

interface MarketauxArticle {
  title?: string;
  description?: string;
  snippet?: string;
  url?: string;
  image_url?: string;
  published_at?: string;  // ISO 8601
  source?: string;        // original outlet name — e.g. "Reuters", "CNBC"
  entities?: MarketauxEntity[];
  sentiment?: string;
}

interface MarketauxResponse {
  data?: MarketauxArticle[];
  error?: { code: string; message: string };
}

function normalizeMarketaux(article: MarketauxArticle): FinnhubArticle {
  // Extract equity tickers from entity list (Marketaux-unique enrichment)
  const tickers = (article.entities ?? [])
    .filter((e) => e.type === "equity" && e.symbol)
    .map((e) => e.symbol!)
    .slice(0, 5);

  return {
    headline: article.title ?? "",
    summary:  (article.description ?? article.snippet ?? "").substring(0, 400),
    url:      article.url ?? "",
    source:   article.source ?? "Marketaux",
    datetime: article.published_at
      ? Math.floor(new Date(article.published_at).getTime() / 1000)
      : 0,
    image:    article.image_url ?? undefined,
    related:  tickers.length > 0 ? tickers : undefined,
  };
}

/**
 * Fetch financial news from Marketaux.
 * Returns FinnhubArticle[] normalized from Marketaux's entity-tagged articles.
 * filter_entities=true ensures every article is tied to a publicly traded company.
 */
export async function fetchMarketauxNews(apiKey: string): Promise<FinnhubArticle[]> {
  if (!apiKey) {
    console.warn("[news-apis:marketaux] MARKETAUX_API_KEY not set — skipping");
    return [];
  }

  try {
    const url = new URL("https://api.marketaux.com/v1/news/all");
    url.searchParams.set("api_token",        apiKey);
    url.searchParams.set("language",         "en");
    url.searchParams.set("filter_entities",  "true");
    url.searchParams.set("must_have_entities", "true");
    url.searchParams.set("sort",             "published_desc");
    url.searchParams.set("limit",            "50");

    const res = await timedFetch(url.toString());
    if (!res.ok) {
      console.error(`[news-apis:marketaux] HTTP ${res.status} — skipping`);
      return [];
    }

    const data = await res.json() as MarketauxResponse;
    if (data.error) {
      console.error(`[news-apis:marketaux] API error ${data.error.code}: ${data.error.message}`);
      return [];
    }

    const articles = (data.data ?? [])
      .map(normalizeMarketaux)
      .filter((a) => a.headline && a.url);

    console.log(`[news-apis:marketaux] Fetched ${articles.length} articles`);
    return articles;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[news-apis:marketaux] ${msg.includes("abort") ? "Timed out" : "Fetch error"}: ${msg}`);
    return [];
  }
}

// ── NewsData.io ───────────────────────────────────────────────────────────────
// Documentation: https://newsdata.io/documentation
// Free tier: 200 credits/day, up to 10 articles per response.
// Uses the /latest endpoint (real-time) rather than /news (archive).
// Three parallel queries: business category, macro/rates keyword, energy keyword.

interface NewsDataArticle {
  title?: string;
  link?: string;
  description?: string;
  content?: string;
  pubDate?: string;         // "2024-01-15 12:00:00" or ISO 8601
  image_url?: string | null;
  source_id?: string;       // domain-based id, e.g. "reuters"
  source_name?: string;     // human-readable name, e.g. "Reuters"
  source_priority?: number;
  creator?: string[] | null;
}

interface NewsDataResponse {
  status?: string;
  results?: NewsDataArticle[];
  message?: string;
}

function normalizeNewsData(article: NewsDataArticle): FinnhubArticle {
  const summary = (article.description ?? article.content ?? "").substring(0, 400);
  const author  = article.creator?.[0];
  // Prefer source_name (human-readable) — falls back to source_id (domain)
  const sourceName = article.source_name ?? article.source_id ?? "NewsData";

  return {
    headline: article.title ?? "",
    summary,
    url:      article.link ?? "",
    source:   sourceName,
    datetime: article.pubDate
      ? Math.floor(new Date(article.pubDate).getTime() / 1000)
      : 0,
    image:    article.image_url ?? undefined,
    related:  author ? [`author:${author}`] : undefined,
  };
}

async function fetchNewsDataQuery(
  apiKey: string,
  params: Record<string, string | undefined>
): Promise<FinnhubArticle[]> {
  try {
    const url = new URL("https://newsdata.io/api/1/latest");
    url.searchParams.set("apikey",    apiKey);
    url.searchParams.set("language",  "en");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const res = await timedFetch(url.toString());
    if (!res.ok) {
      console.error(
        `[news-apis:newsdata] HTTP ${res.status} for query=${JSON.stringify(params)} — skipping`
      );
      return [];
    }

    const data = await res.json() as NewsDataResponse;
    if (data.status !== "success") {
      console.error(`[news-apis:newsdata] API error: ${data.message ?? "unknown"}`);
      return [];
    }

    return (data.results ?? [])
      .map(normalizeNewsData)
      .filter((a) => a.headline && a.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[news-apis:newsdata] ${msg.includes("abort") ? "Timed out" : "Fetch error"} ` +
      `for query=${JSON.stringify(params)}: ${msg}`
    );
    return [];
  }
}

/**
 * Fetch financial news from NewsData.io across three parallel queries.
 * Returns FinnhubArticle[] normalized from NewsData's article schema.
 */
export async function fetchNewsDataNews(apiKey: string): Promise<FinnhubArticle[]> {
  if (!apiKey) {
    console.warn("[news-apis:newsdata] NEWSDATA_API_KEY not set — skipping");
    return [];
  }

  // Parallel queries for breadth across macro, business, and energy topics.
  // Each query costs 1 credit from the free-tier 200/day budget.
  const queries = [
    { category: "business" },
    { q: "federal reserve interest rate inflation" },
    { q: "oil crude energy opec commodities" },
  ];

  const results = await Promise.allSettled(
    queries.map((params) => fetchNewsDataQuery(apiKey, params))
  );

  const all: FinnhubArticle[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") all.push(...result.value);
  }

  console.log(
    `[news-apis:newsdata] Fetched ${all.length} articles across ${queries.length} queries`
  );
  return all;
}

// ── GNews ─────────────────────────────────────────────────────────────────────
// Documentation: https://gnews.io/docs/v4
// Free tier: 100 requests/day, max 10 articles per request.
// Uses both top-headlines (category=business) and keyword search for breadth.
// GNews truncates content with "[X chars]" suffixes — always use description.

interface GNewsSource {
  name?: string;
  url?: string;
}

interface GNewsArticle {
  title?: string;
  description?: string;
  content?: string;  // Truncated — prefer description
  url?: string;
  image?: string;
  publishedAt?: string;  // ISO 8601
  source?: GNewsSource;
}

interface GNewsResponse {
  totalArticles?: number;
  articles?: GNewsArticle[];
  errors?: string[];
}

function normalizeGNews(article: GNewsArticle): FinnhubArticle {
  return {
    headline: article.title ?? "",
    // Prefer description — GNews content is truncated with "[X chars]" suffix
    summary:  (article.description ?? "").substring(0, 400),
    url:      article.url ?? "",
    source:   article.source?.name ?? "GNews",
    datetime: article.publishedAt
      ? Math.floor(new Date(article.publishedAt).getTime() / 1000)
      : 0,
    image: article.image ?? undefined,
  };
}

async function fetchGNewsQuery(
  apiKey: string,
  params: Record<string, string | undefined>
): Promise<FinnhubArticle[]> {
  try {
    // /search requires q param; /top-headlines uses category param
    const endpoint = params.q ? "search" : "top-headlines";
    const url = new URL(`https://gnews.io/api/v4/${endpoint}`);
    url.searchParams.set("token",   apiKey);
    url.searchParams.set("lang",    "en");
    url.searchParams.set("country", "us");
    url.searchParams.set("max",     "10");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const res = await timedFetch(url.toString());
    if (!res.ok) {
      console.error(
        `[news-apis:gnews] HTTP ${res.status} for endpoint=${endpoint} query=${JSON.stringify(params)} — skipping`
      );
      return [];
    }

    const data = await res.json() as GNewsResponse;
    if (data.errors?.length) {
      console.error(`[news-apis:gnews] API errors: ${data.errors.join(", ")}`);
      return [];
    }

    return (data.articles ?? [])
      .map(normalizeGNews)
      .filter((a) => a.headline && a.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[news-apis:gnews] ${msg.includes("abort") ? "Timed out" : "Fetch error"} ` +
      `for query=${JSON.stringify(params)}: ${msg}`
    );
    return [];
  }
}

/**
 * Fetch financial news from GNews across three parallel queries.
 * Returns FinnhubArticle[] normalized from GNews's article schema.
 */
export async function fetchGNewsNews(apiKey: string): Promise<FinnhubArticle[]> {
  if (!apiKey) {
    console.warn("[news-apis:gnews] GNEWS_API_KEY not set — skipping");
    return [];
  }

  // Parallel queries: business headlines + two keyword searches.
  // Each request costs 1 of the free-tier 100/day budget.
  const queries = [
    { category: "business" },                             // top-headlines
    { q: "stock market S&P 500 federal reserve" },       // search
    { q: "oil energy OPEC inflation economy" },          // search
  ];

  const results = await Promise.allSettled(
    queries.map((params) => fetchGNewsQuery(apiKey, params))
  );

  const all: FinnhubArticle[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") all.push(...result.value);
  }

  console.log(
    `[news-apis:gnews] Fetched ${all.length} articles across ${queries.length} queries`
  );
  return all;
}
