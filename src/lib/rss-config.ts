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
  // Note: feeds.reuters.com is deprecated; requests from server-side IPs
  // (e.g. Vercel) fail with a network error. Reuters articles arrive via
  // Finnhub and NewsAPI. Disabled until Reuters publishes a new RSS endpoint.
  {
    name: "Reuters Business News",
    source: "Reuters",
    url: "https://feeds.reuters.com/reuters/businessNews",
    category: "business",
    priority: 1,
    disabled: true,
  },
  {
    name: "Reuters Markets News",
    source: "Reuters",
    url: "https://feeds.reuters.com/reuters/marketsNews",
    category: "markets",
    priority: 1,
    disabled: true,
  },
  {
    name: "Reuters Finance News",
    source: "Reuters",
    url: "https://feeds.reuters.com/news/archivedContent",
    category: "macro",
    priority: 1,
    disabled: true,
  },

  // Associated Press
  // Note: feeds.apnews.com blocks non-browser server requests. AP articles
  // arrive via Finnhub and NewsAPI. Disabled until a stable server-accessible
  // AP RSS endpoint is available.
  {
    name: "AP Business News",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-business",
    category: "business",
    priority: 1,
    disabled: true,
  },
  {
    name: "AP Economy News",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-economy",
    category: "macro",
    priority: 1,
    disabled: true,
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
    disabled: true, // consistently 0 items in production logs
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
    disabled: true, // consistently 0 items in production logs
  },

  // Wall Street Journal
  // Note: feeds.a.dj.com endpoints consistently return 0 items from server-side
  // IPs (likely auth-gated at the CDN level). WSJ articles arrive via Finnhub.
  {
    name: "WSJ Markets News",
    source: "Wall Street Journal",
    url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    category: "markets",
    priority: 1,
    disabled: true, // 0 items from server-side IPs — Dow Jones CDN blocks
  },
  {
    name: "WSJ Business News",
    source: "Wall Street Journal",
    url: "https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml",
    category: "business",
    priority: 1,
    disabled: true, // 0 items from server-side IPs — Dow Jones CDN blocks
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
  // Note: barrons.com/feed/rss/news returns HTTP 403 from server-side IPs.
  // Barron's headlines arrive via Finnhub. Disabled until a public endpoint
  // is confirmed accessible.
  {
    name: "Barron's Markets",
    source: "Barron's",
    url: "https://www.barrons.com/feed/rss/news",
    category: "markets",
    priority: 1,
    disabled: true,
  },

  // The Economist
  {
    name: "The Economist Finance",
    source: "The Economist",
    url: "https://www.economist.com/finance-and-economics/rss.xml",
    category: "macro",
    priority: 1,
  },

  // Bloomberg — additional topic feeds (beyond Markets + Economics above)
  {
    name: "Bloomberg Technology",
    source: "Bloomberg",
    url: "https://feeds.bloomberg.com/technology/news.rss",
    category: "business",
    priority: 1,
  },
  {
    name: "Bloomberg Politics",
    source: "Bloomberg",
    url: "https://feeds.bloomberg.com/politics/news.rss",
    category: "policy",
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
    disabled: true, // feeds.reuters.com blocks server-side IPs
  },
  {
    name: "Reuters Politics",
    source: "Reuters",
    url: "https://feeds.reuters.com/reuters/politicsNews",
    category: "geopolitics",
    priority: 1,
    disabled: true, // feeds.reuters.com blocks server-side IPs
  },
  {
    name: "AP International News",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-intlnews",
    category: "geopolitics",
    priority: 1,
    disabled: true, // feeds.apnews.com blocks server-side IPs
  },
  {
    name: "AP Politics",
    source: "Associated Press",
    url: "https://feeds.apnews.com/rss/apf-politics",
    category: "policy",
    priority: 1,
    disabled: true, // feeds.apnews.com blocks server-side IPs
  },
  {
    name: "Financial Times World",
    source: "Financial Times",
    url: "https://www.ft.com/rss/world",
    category: "geopolitics",
    priority: 1,
  },

  // BBC — publicly accessible RSS, no server-side IP restrictions
  {
    name: "BBC Business News",
    source: "BBC",
    url: "https://feeds.bbci.co.uk/news/business/rss.xml",
    category: "business",
    priority: 1,
  },
  {
    name: "BBC World News",
    source: "BBC",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    category: "geopolitics",
    priority: 1,
  },

  // The Guardian — open RSS platform, no server-side IP restrictions
  {
    name: "The Guardian Business",
    source: "The Guardian",
    url: "https://www.theguardian.com/uk/business/rss",
    category: "business",
    priority: 1,
  },
  {
    name: "The Guardian Economics",
    source: "The Guardian",
    url: "https://www.theguardian.com/business/economics/rss",
    category: "macro",
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

  // Fortune
  {
    name: "Fortune Business",
    source: "Fortune",
    url: "https://fortune.com/feed/fortune-feed/",
    category: "business",
    priority: 2,
    disabled: true, // HTTP 404 in production logs
  },

  // Forbes
  // Note: forbes.com RSS endpoints return HTTP 404 from server-side IPs.
  // Forbes articles arrive via NewsAPI.
  {
    name: "Forbes Business",
    source: "Forbes",
    url: "https://www.forbes.com/feeds/forbesglobalmarkets.rss",
    category: "business",
    priority: 2,
    disabled: true, // HTTP 404 in production logs
  },
  {
    name: "Forbes Money",
    source: "Forbes",
    url: "https://www.forbes.com/money/feed/",
    category: "markets",
    priority: 2,
    disabled: true, // HTTP 404 in production logs
  },

  // Business Insider
  {
    name: "Business Insider Markets",
    source: "Business Insider",
    url: "https://markets.businessinsider.com/rss/news",
    category: "markets",
    priority: 2,
  },
  {
    name: "Business Insider Finance",
    source: "Business Insider",
    url: "https://www.businessinsider.com/rss",
    category: "business",
    priority: 2,
  },

  // Benzinga — real-time market news, earnings, analyst upgrades
  {
    name: "Benzinga News",
    source: "Benzinga",
    url: "https://www.benzinga.com/feed",
    category: "markets",
    priority: 2,
  },

  // Morningstar — investment analysis and market news
  {
    name: "Morningstar Market News",
    source: "Morningstar",
    url: "https://news.morningstar.com/rss/topStories.xml",
    category: "markets",
    priority: 2,
    disabled: true, // connection timeout in production logs
  },

  // The Street — stock analysis and financial news
  {
    name: "The Street Markets",
    source: "The Street",
    url: "https://www.thestreet.com/rss/index.xml",
    category: "markets",
    priority: 2,
    disabled: true, // HTTP 403 in production logs
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
    disabled: true, // HTTP 404 in production logs
  },

  // Investing.com — global markets, economy, earnings, commodities
  {
    name: "Investing.com Stock Market News",
    source: "Investing.com",
    url: "https://www.investing.com/rss/news_25.rss",
    category: "markets",
    priority: 2,
  },
  {
    name: "Investing.com Economy & Business",
    source: "Investing.com",
    url: "https://www.investing.com/rss/news_14.rss",
    category: "macro",
    priority: 2,
  },
  {
    name: "Investing.com Earnings",
    source: "Investing.com",
    url: "https://www.investing.com/rss/news_1062.rss",
    category: "markets",
    priority: 2,
  },
  {
    name: "Investing.com Analyst Ratings",
    source: "Investing.com",
    url: "https://www.investing.com/rss/news_1061.rss",
    category: "markets",
    priority: 2,
  },
  {
    name: "Investing.com Commodities",
    source: "Investing.com",
    url: "https://www.investing.com/rss/news_11.rss",
    category: "energy",
    priority: 2,
  },

  // OilPrice.com — dedicated energy news
  {
    name: "OilPrice Energy News",
    source: "OilPrice.com",
    url: "https://oilprice.com/rss/main",
    category: "energy",
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

  // BLS (Bureau of Labor Statistics) — official jobs/inflation data releases
  // These feeds capture market-moving economic reports (CPI, payrolls, etc.)
  {
    name: "BLS All Economic News Releases",
    source: "BLS",
    url: "https://www.bls.gov/feed/bls_latest.rss",
    category: "macro",
    priority: 2,
  },
  // BLS publishes one unified release feed (bls_latest.rss above).
  // The sub-feeds below exist on some mirrors but 404 on the official site —
  // disable until confirmed working.
  {
    name: "BLS CPI (Inflation)",
    source: "BLS",
    url: "https://www.bls.gov/feed/bls_cpi.rss",
    category: "macro",
    priority: 2,
    disabled: true,
  },
  {
    name: "BLS Employment Situation (Payrolls)",
    source: "BLS",
    url: "https://www.bls.gov/feed/bls_ces.rss",
    category: "macro",
    priority: 2,
    disabled: true,
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
    disabled: true, // connection timeout in production logs
  },

  // CFTC (Commodity Futures Trading Commission) — regulatory/derivatives/commodities
  {
    name: "CFTC Press Releases",
    source: "CFTC",
    url: "https://www.cftc.gov/rss/pressreleases.xml",
    category: "policy",
    priority: 2,
    disabled: true, // HTTP 404 in production logs
  },

  // Foreign Policy — geopolitical analysis with direct market implications
  {
    name: "Foreign Policy",
    source: "Foreign Policy",
    url: "https://foreignpolicy.com/feed/",
    category: "geopolitics",
    priority: 2,
  },

  // NPR — open feeds, no server-side IP restrictions
  {
    name: "NPR Business",
    source: "NPR",
    url: "https://feeds.npr.org/1006/rss.xml",
    category: "business",
    priority: 2,
  },
  {
    name: "NPR Economy",
    source: "NPR",
    url: "https://feeds.npr.org/1017/rss.xml",
    category: "macro",
    priority: 2,
  },

  // Politico — policy and economic news
  {
    name: "Politico Economy",
    source: "Politico",
    url: "https://rss.politico.com/economy.xml",
    category: "policy",
    priority: 2,
  },

  // FRED Blog (St. Louis Fed) — economic research and data commentary
  {
    name: "FRED Blog",
    source: "Federal Reserve Bank of St. Louis",
    url: "https://fredblog.stlouisfed.org/feed/",
    category: "macro",
    priority: 2,
  },

  // Nasdaq — official market and company news from Nasdaq's newsroom
  {
    name: "Nasdaq Market News",
    source: "Nasdaq",
    url: "https://www.nasdaq.com/feed/rssoutbound?category=Markets",
    category: "markets",
    priority: 2,
  },

  // TechCrunch — technology business, M&A, and venture funding (market signals)
  {
    name: "TechCrunch",
    source: "TechCrunch",
    url: "https://techcrunch.com/feed/",
    category: "business",
    priority: 2,
  },

  // CoinDesk — crypto markets and blockchain news (digital asset price signals)
  {
    name: "CoinDesk News",
    source: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    category: "markets",
    priority: 2,
  },

  // CoinTelegraph — crypto and blockchain markets
  {
    name: "CoinTelegraph",
    source: "CoinTelegraph",
    url: "https://cointelegraph.com/rss",
    category: "markets",
    priority: 2,
  },

  // World Bank Blog — global economic development and emerging market signals
  {
    name: "World Bank Blog",
    source: "World Bank",
    url: "https://blogs.worldbank.org/rss.xml",
    category: "global",
    priority: 2,
  },

  // IMF Blog — supplementary to IMF News; in-depth macro analysis
  {
    name: "IMF Blog",
    source: "IMF",
    url: "https://www.imf.org/en/blogs/rss",
    category: "macro",
    priority: 2,
  },

  // CNBC additional sections (alternative feed IDs)
  {
    name: "CNBC Investing",
    source: "CNBC",
    url: "https://www.cnbc.com/id/15839069/device/rss/rss.html",
    category: "markets",
    priority: 1,
  },
  {
    name: "CNBC Top News",
    source: "CNBC",
    url: "https://www.cnbc.com/id/100003241/device/rss/rss.html",
    category: "markets",
    priority: 1,
  },

  // Wired Business — AI, tech, and corporate strategy stories with market impact
  {
    name: "Wired Business",
    source: "Wired",
    url: "https://www.wired.com/feed/category/business/latest/rss",
    category: "business",
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
