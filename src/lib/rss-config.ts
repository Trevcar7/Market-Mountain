/**
 * Centralized RSS Feed Configuration
 *
 * Single source of truth for all RSS feeds entering the Market Mountain pipeline.
 * Add or remove feeds here; no other code changes required.
 *
 * category: maps to the pipeline's broad category signal (used by filterByRelevance
 *           and groupRelatedArticles for initial topic inference).
 * priority: 1 = highest credibility weight. Mirrors source-tier classification
 *           in news.ts (Tier 1 = Reuters/Bloomberg/FT/WSJ/AP/CNBC; Tier 2 = others).
 *           Optional; defaults to 2 if omitted.
 */

export type RssFeedCategory =
  | "macro"
  | "markets"
  | "business"
  | "energy"
  | "policy"
  | "global"
  | "geopolitics";

export interface RssSourceConfig {
  /** Human-readable feed name, e.g. "Reuters Business News" */
  name: string;
  /**
   * Canonical source identifier stored in the normalized article's `source` field.
   * Should match a name in TIER_1_SOURCES or TIER_2_SOURCES in news.ts so the
   * article receives proper credibility weighting throughout the pipeline.
   */
  source: string;
  /** RSS 2.0 or Atom 1.0 feed URL */
  url: string;
  /** Broad topic category for initial classification */
  category: RssFeedCategory;
  /**
   * Optional credibility priority hint (1 = Tier 1, 2 = Tier 2).
   * Used only for logging; actual tier assignment uses getSourceTier() in news.ts.
   */
  priority?: 1 | 2;
  /** If true, this feed is skipped during fetching (useful for temporarily disabling). */
  disabled?: boolean;
}

/**
 * Canonical list of RSS feeds.
 *
 * Organized by priority tier then category:
 *   Tier 1 — premium English-language financial journalism
 *   Tier 2 — institutional data sources and quality financial outlets
 *
 * Note on paywalled outlets (FT, WSJ, Bloomberg):
 *   Their RSS feeds surface headlines and abstracts even for subscribers-only
 *   articles. The synthesizer uses headlines + summaries as signals; the full
 *   article text is never fetched, so paywalls do not block the pipeline.
 *   If a feed returns 403/404 the fetcher logs a warning and continues.
 */
export const RSS_FEEDS: RssSourceConfig[] = [
  // ─── Tier 1 — Premium financial journalism ───────────────────────────────

  // Reuters
  {
    name: "Reuters Business News",
    source: "Reuters",
    url: "https://feeds.reuters.com/reuters/businessNews",
    category: "business",
    priority: 1,
  },
  {
    name: "Reuters Markets News",
    source: "Reuters",
    url: "https://feeds.reuters.com/reuters/marketsNews",
    category: "markets",
    priority: 1,
  },
  {
    name: "Reuters Finance News",
    source: "Reuters",
    url: "https://feeds.reuters.com/news/archivedContent",
    category: "macro",
    priority: 1,
  },

  // Associated Press
  {
    name: "AP Business News",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-business",
    category: "business",
    priority: 1,
  },
  {
    name: "AP Economy News",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-economy",
    category: "macro",
    priority: 1,
  },

  // CNBC
  {
    name: "CNBC Markets",
    source: "CNBC",
    url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    category: "markets",
    priority: 1,
  },
  {
    name: "CNBC Economy",
    source: "CNBC",
    url: "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    category: "macro",
    priority: 1,
  },
  {
    name: "CNBC Finance",
    source: "CNBC",
    url: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    category: "business",
    priority: 1,
  },

  // MarketWatch
  {
    name: "MarketWatch Top Stories",
    source: "MarketWatch",
    url: "https://feeds.marketwatch.com/marketwatch/topstories/",
    category: "markets",
    priority: 1,
  },
  {
    name: "MarketWatch Real Time Headlines",
    source: "MarketWatch",
    url: "https://feeds.marketwatch.com/marketwatch/realtimeheadlines/",
    category: "markets",
    priority: 1,
  },

  // Wall Street Journal
  {
    name: "WSJ Markets News",
    source: "Wall Street Journal",
    url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    category: "markets",
    priority: 1,
  },
  {
    name: "WSJ Business News",
    source: "Wall Street Journal",
    url: "https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml",
    category: "business",
    priority: 1,
  },

  // Financial Times
  {
    name: "Financial Times Home",
    source: "Financial Times",
    url: "https://www.ft.com/rss/home",
    category: "global",
    priority: 1,
  },
  {
    name: "Financial Times Markets",
    source: "Financial Times",
    url: "https://www.ft.com/rss/markets",
    category: "markets",
    priority: 1,
  },

  // Bloomberg (public headlines feed — no subscription required)
  {
    name: "Bloomberg Markets",
    source: "Bloomberg",
    url: "https://feeds.bloomberg.com/markets/news.rss",
    category: "markets",
    priority: 1,
  },
  {
    name: "Bloomberg Economics",
    source: "Bloomberg",
    url: "https://feeds.bloomberg.com/economics/news.rss",
    category: "macro",
    priority: 1,
  },

  // Barron's
  {
    name: "Barron's Markets",
    source: "Barron's",
    url: "https://www.barrons.com/feed/rss/news",
    category: "markets",
    priority: 1,
  },

  // The Economist
  {
    name: "The Economist Finance",
    source: "The Economist",
    url: "https://www.economist.com/finance-and-economics/rss.xml",
    category: "macro",
    priority: 1,
  },

  // ─── Geopolitics feeds — market-moving global events ─────────────────────
  // Geopolitical events (sanctions, conflicts, trade disputes) directly affect
  // energy prices, FX, and risk sentiment. These feeds surface such signals early.

  {
    name: "Reuters World News",
    source: "Reuters",
    url: "https://feeds.reuters.com/reuters/worldNews",
    category: "geopolitics",
    priority: 1,
  },
  {
    name: "Reuters Politics",
    source: "Reuters",
    url: "https://feeds.reuters.com/reuters/politicsNews",
    category: "geopolitics",
    priority: 1,
  },
  {
    name: "AP International News",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-intlnews",
    category: "geopolitics",
    priority: 1,
  },
  {
    name: "AP Politics",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-politics",
    category: "policy",
    priority: 1,
  },
  {
    name: "Financial Times World",
    source: "Financial Times",
    url: "https://www.ft.com/rss/world",
    category: "geopolitics",
    priority: 1,
  },

  // ─── Tier 2 — Quality financial outlets ──────────────────────────────────

  // Yahoo Finance
  {
    name: "Yahoo Finance News",
    source: "Yahoo Finance",
    url: "https://finance.yahoo.com/news/rssindex",
    category: "markets",
    priority: 2,
  },

  // Forbes
  {
    name: "Forbes Business",
    source: "Forbes",
    url: "https://www.forbes.com/feeds/forbesglobalmarkets.rss",
    category: "business",
    priority: 2,
  },

  // Seeking Alpha (editorial, not community)
  {
    name: "Seeking Alpha Market News",
    source: "Seeking Alpha",
    url: "https://seekingalpha.com/market_currents.xml",
    category: "markets",
    priority: 2,
  },

  // Investopedia
  {
    name: "Investopedia News",
    source: "Investopedia",
    url: "https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=rss_headline",
    category: "markets",
    priority: 2,
  },

  // EIA (US Energy Information Administration) — official energy data
  {
    name: "EIA Today in Energy",
    source: "EIA",
    url: "https://www.eia.gov/rss/todayinenergy.xml",
    category: "energy",
    priority: 2,
  },

  // Federal Reserve (official press releases and speeches)
  {
    name: "Federal Reserve Press Releases",
    source: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    category: "policy",
    priority: 2,
  },
  {
    name: "Federal Reserve Speeches",
    source: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/speeches.xml",
    category: "macro",
    priority: 2,
  },

  // IMF
  {
    name: "IMF News",
    source: "IMF",
    url: "https://www.imf.org/en/News/rss?language=eng",
    category: "global",
    priority: 2,
  },

  // Treasury.gov
  {
    name: "US Treasury Press Releases",
    source: "Treasury",
    url: "https://home.treasury.gov/system/files/206/treasury-press-releases.rss",
    category: "policy",
    priority: 2,
  },

  // ─── Sources not yet fully configured — add URLs when available ──────────
  //
  // Bloomberg: Public RSS endpoints are increasingly rate-limited / paywalled.
  //   The feeds.bloomberg.com entries above deliver headlines only; full-text
  //   access requires a subscription. If Bloomberg disables public RSS, set
  //   disabled: true on those entries and rely on Finnhub (which already
  //   surfaces Bloomberg headlines via its /news endpoint).
  //
  // Financial Times: FT RSS feeds (ft.com/rss/*) return titles and abstracts
  //   for all articles, including subscriber-only pieces. The pipeline only
  //   uses headlines and summaries, so paywalled full text is not an issue.
  //   If FT restricts RSS in the future, mark entries as disabled: true.
  //
  // Wall Street Journal (Dow Jones): The feeds.a.dj.com endpoints above are
  //   the public-facing WSJ RSS feeds. If Dow Jones restricts them, obtain
  //   a WSJ RSS token and add it as a query parameter to the URL.
  //   Placeholder: disabled: true entry template:
  //   { name: "WSJ Premium", source: "Wall Street Journal",
  //     url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml?token=YOUR_TOKEN",
  //     category: "markets", priority: 1, disabled: true }
  //
  // Barron's: Uses the same Dow Jones infrastructure as WSJ.
  //   Current URL (barrons.com/feed/rss/news) may require authentication.
  //   If blocked, the fetcher will log a warning and continue without it.
  //
  // The Economist: economist.com RSS is freely available for section-level
  //   feeds. If URL changes, find current feed at economist.com/rss.
];

/**
 * Return only enabled feeds (not disabled).
 * Call this rather than RSS_FEEDS directly in production code.
 */
export function getEnabledFeeds(): RssSourceConfig[] {
  return RSS_FEEDS.filter((f) => !f.disabled);
}

/**
 * Return feeds filtered by category.
 */
export function getFeedsByCategory(category: RssFeedCategory): RssSourceConfig[] {
  return getEnabledFeeds().filter((f) => f.category === category);
}
