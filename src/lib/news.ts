import {
  FinnhubArticle,
  NewsAPIArticle,
  GroupedNews,
} from "./news-types";

/**
 * Financial market keywords for filtering relevance.
 * Keep this list broad — the importance scorer handles quality ranking downstream.
 */
const MARKET_KEYWORDS = [
  // Central bank / monetary policy
  "federal reserve",
  "fed ",           // trailing space avoids "confederate", "alfred", etc.
  "rate hike",
  "rate cut",
  "rate pause",
  "interest rate",
  "fomc",
  "powell",

  // Macro indicators
  "inflation",
  "gdp",
  "recession",
  "supply chain",
  "cpi",
  "ppi",
  "jobs report",
  "employment",
  "unemployment",
  "treasury",
  "yield curve",
  "bond market",
  "economy",
  "economic",
  "deficit",
  "debt ceiling",
  "stimulus",

  // Broad market terms (surprisingly absent before)
  "market",
  "markets",
  "stock",
  "stocks",
  "shares",
  "equity",
  "equities",
  "wall street",
  "s&p",
  "nasdaq",
  "dow jones",
  "dow ",           // trailing space avoids "shadow", etc.
  "sector rotation",
  "market rally",
  "market crash",
  "bull market",
  "bear market",
  "market volatility",
  "trading halt",
  "circuit breaker",
  "vix",
  "rally",
  "selloff",
  "sell-off",

  // Company financials / earnings
  "earnings",
  "earnings beat",
  "earnings miss",
  "revenue",
  "revenues",
  "profit",
  "profits",
  "quarterly",
  "quarter",
  "guidance",
  "outlook",
  "forecast",
  "analyst",
  "analysts",
  "price target",
  "upgrade",
  "downgrade",
  "dividend",
  "stock split",
  "buyback",
  "share repurchase",
  "profit margin",
  "ebitda",
  "eps",

  // Corporate events
  "ipo",
  "merger",
  "acquisition",
  "bankruptcy",
  "chapter 11",
  "layoff",
  "layoffs",
  "job cuts",
  "restructuring",

  // Investors / funds
  "investor",
  "investors",
  "hedge fund",
  "private equity",
  "etf",
  "fund manager",
  "portfolio",

  // Commodities / energy
  "oil price",
  "oil prices",
  "crude oil",
  "commodity",
  "commodities",
  "gold price",
  "silver",
  "opec",

  // Crypto
  "crypto",
  "bitcoin",
  "ethereum",
  "digital asset",
  "blockchain",

  // Trade & policy
  "regulatory",
  "sec",
  "tariff",
  "tariffs",
  "trade war",
  "trade deal",
  "sanctions",
  "currency",
  "dollar",
  "inflation data",

  // Credit / debt
  "credit rating",
  "default",

  // Notable people / companies
  "elon musk",
  "berkshire hathaway",
  "warren buffett",
  "jerome powell",
  "janet yellen",
];

const BLOCKED_DOMAINS = [
  "reddit.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "stocktwits.com",
  "seekingalpha.com/article", // SA community articles, not news
];

/**
 * Blocked source names — low-quality, non-financial, or pure press-release outlets.
 * Matched case-insensitively against source name.
 *
 * Note: BusinessWire and GlobeNewswire are NOT blocked — they carry official earnings
 * releases and IR disclosures that are valid primary sources. Their tier-0 status means
 * they can't anchor a story alone (confidence gate handles quality control).
 */
const BLOCKED_SOURCES = [
  // Indian regional / non-financial press
  "times of india",
  "the times of india",
  "hindustan times",
  "the hindu",
  "businessline",
  "livemint",
  "ndtv profit",
  // Tech/general aggregators with minimal financial editorial value
  "slashdot",
  "digg",
  "flipboard",
  "msn",                // MSN aggregates but adds no original reporting
  // Entertainment / tabloid
  "yahoo entertainment",
  "tmz",
  "buzzfeed",
  "huffpost",
  "huffington post",
  "daily mail",
  "the sun",
  "new york post",
  "national enquirer",
  "people magazine",
  "variety",
  "hollywood reporter",
  // Pure PR wire services (no editorial review; corporate self-promotion only)
  "prweb",
  "accesswire",
  "prnewswire",         // PR Newswire — pure press release distribution
  "ein presswire",
  "einpresswire",
  "openpr",
  "newswire",           // generic newswire aggregator (not Reuters)
  // Low-quality financial clickbait
  "the motley fool blog",
  "wisesheets",
  "stockanalysis",
];

/**
 * Tier 1 — Premium English-language financial news sources.
 * Articles from these sources carry the highest credibility weight.
 */
export const TIER_1_SOURCES = [
  "reuters",
  "bloomberg",
  "wall street journal",
  "wsj",
  "financial times",
  "ft.com",
  "ap news",
  "associated press",
  "cnbc",
  "marketwatch",
  "market watch",
  "barron",
  "the economist",
  "economist.com",
];

/**
 * Tier 2 — Official government data sources, institutional research, and
 * specialized financial/business outlets.
 */
export const TIER_2_SOURCES = [
  // US government data agencies
  "fred",
  "bls",
  "eia",
  "census.gov",
  "bea.gov",             // Bureau of Economic Analysis
  "federalreserve.gov",
  "treasury.gov",
  "sec.gov",
  "cbo.gov",             // Congressional Budget Office
  // International institutional
  "imf",
  "world bank",
  "worldbank",
  "bis.org",             // Bank for International Settlements
  "oecd",
  // Quality financial outlets (below Tier 1 but reliable)
  "morningstar",
  "seeking alpha",       // SA editorial (not community articles)
  "investopedia",
  "the street",
  "thestreet",
  "fortune",
  "forbes",
  "business insider",
  // Crypto-specific quality outlets
  "coindesk",
  "the block",
  "cointelegraph",
];

/**
 * Return the source tier (0 = unknown, 1 = premium news, 2 = official data).
 */
export function getSourceTier(sourceName: string): 0 | 1 | 2 {
  const lower = sourceName.toLowerCase();
  if (TIER_1_SOURCES.some((s) => lower.includes(s))) return 1;
  if (TIER_2_SOURCES.some((s) => lower.includes(s))) return 2;
  return 0;
}

/**
 * Return true if at least one article in the group comes from a Tier 1 or Tier 2 source.
 */
export function hasQualitySource(
  articles: (FinnhubArticle | NewsAPIArticle)[]
): boolean {
  return articles.some((article) => {
    const source = isFinnhub(article)
      ? (article as FinnhubArticle).source || ""
      : (article as NewsAPIArticle).source?.name || "";
    return getSourceTier(source) >= 1;
  });
}

/**
 * Trusted financial news sources — articles from these outlets bypass keyword
 * filtering and are always considered relevant.
 * Matched against source name (Finnhub) or source.name (NewsAPI), lowercase.
 * Must overlap with TIER_1_SOURCES + TIER_2_SOURCES + reputable general business press.
 */
const TRUSTED_FINANCIAL_SOURCES = [
  // Tier 1 premium outlets (also listed in TIER_1_SOURCES)
  "reuters",
  "bloomberg",
  "wall street journal",
  "wsj",
  "financial times",
  "ft.com",
  "ap news",
  "associated press",
  "cnbc",
  "marketwatch",
  "market watch",
  "barron",
  "the economist",
  // Government/institutional (Tier 2)
  "federal reserve",
  "sec.gov",
  "treasury.gov",
  "bls.gov",
  "eia.gov",
  // Quality financial publications
  "morningstar",
  "seeking alpha",
  "benzinga",
  "investopedia",
  "the street",
  "thestreet",
  "zacks",
  "business insider",
  "fortune",
  "forbes",
  "yahoo finance",
  // Wire services (legitimate primary-source distribution)
  "business wire",
  "businesswire",
  "globe newswire",
  "globenewswire",
  "dow jones",
];

/**
 * Fetch news from Finnhub API
 * Requires FINNHUB_API_KEY env var
 */
export async function fetchFinnhubNews(
  apiKey: string,
  category = "general"
): Promise<FinnhubArticle[]> {
  try {
    const url = new URL("https://finnhub.io/api/v1/news");
    url.searchParams.set("category", category);
    url.searchParams.set("minId", "0");
    url.searchParams.set("token", apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(`Finnhub API error: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as FinnhubArticle[];
    return data || [];
  } catch (error) {
    console.error("Error fetching Finnhub news:", error);
    return [];
  }
}

/**
 * Fetch news from NewsAPI for a single query
 * Requires NEWSAPI_API_KEY env var
 */
export async function fetchNewsAPINews(
  apiKey: string,
  query = "financial market"
): Promise<NewsAPIArticle[]> {
  try {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", query);
    url.searchParams.set("language", "en");
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("apiKey", apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(`NewsAPI error: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as { articles: NewsAPIArticle[] };
    return data.articles || [];
  } catch (error) {
    console.error("Error fetching NewsAPI news:", error);
    return [];
  }
}

/**
 * Fetch news from NewsAPI across multiple topic queries in parallel.
 * Covers macro, earnings, crypto, energy, and general markets for breadth.
 */
export async function fetchNewsAPIMultiple(
  apiKey: string
): Promise<NewsAPIArticle[]> {
  const queries = [
    "federal reserve interest rate inflation",
    "stock earnings revenue quarterly results",
    "cryptocurrency bitcoin ethereum",
    "oil energy commodities opec",
    "S&P 500 nasdaq stock market",
  ];

  const results = await Promise.allSettled(
    queries.map((q) => fetchNewsAPINews(apiKey, q))
  );

  const all: NewsAPIArticle[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      all.push(...result.value);
    }
  }

  return all;
}

/**
 * Filter articles to only those published within the last maxAgeHours hours.
 * Drops stale articles that would produce repetitive/outdated stories.
 */
export function filterByAge(
  articles: (FinnhubArticle | NewsAPIArticle)[],
  maxAgeHours = 12
): (FinnhubArticle | NewsAPIArticle)[] {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  return articles.filter((article) => {
    const timeMs = isFinnhub(article)
      ? ((article as FinnhubArticle).datetime || 0) * 1000
      : new Date((article as NewsAPIArticle).publishedAt || 0).getTime();

    return timeMs >= cutoff;
  });
}

/**
 * Filter articles by relevance to financial markets.
 * Articles from trusted financial sources auto-pass.
 * All others are checked against the MARKET_KEYWORDS list.
 */
export function filterByRelevance(articles: (FinnhubArticle | NewsAPIArticle)[]): (FinnhubArticle | NewsAPIArticle)[] {
  return articles.filter((article) => {
    const headline = isFinnhub(article)
      ? (article as FinnhubArticle).headline || ""
      : (article as NewsAPIArticle).title || "";

    const summary = isFinnhub(article)
      ? (article as FinnhubArticle).summary || ""
      : (article as NewsAPIArticle).description || "";

    const url = isFinnhub(article)
      ? (article as FinnhubArticle).url || ""
      : (article as NewsAPIArticle).url || "";

    const source = (
      isFinnhub(article)
        ? (article as FinnhubArticle).source || ""
        : (article as NewsAPIArticle).source?.name || ""
    ).toLowerCase();

    const lowerUrl = url.toLowerCase();
    const combinedText = `${headline} ${summary}`.toLowerCase();

    // Hard block — social media / forums
    if (BLOCKED_DOMAINS.some((domain) => lowerUrl.includes(domain))) {
      return false;
    }

    // Hard block — known low-quality or non-financial sources
    if (BLOCKED_SOURCES.some((s) => source.includes(s))) {
      return false;
    }

    // Auto-pass known financial publishers — no keyword check needed
    if (
      TRUSTED_FINANCIAL_SOURCES.some(
        (s) => source.includes(s) || lowerUrl.includes(s)
      )
    ) {
      return true;
    }

    // Keyword check for all other sources
    return MARKET_KEYWORDS.some((keyword) =>
      combinedText.includes(keyword.toLowerCase())
    );
  });
}

/**
 * Remove duplicate articles by headline/title
 */
export function deduplicateNews(articles: (FinnhubArticle | NewsAPIArticle)[]): (FinnhubArticle | NewsAPIArticle)[] {
  const seen = new Set<string>();
  return articles.filter((article) => {
    const headline = isFinnhub(article)
      ? (article as FinnhubArticle).headline
      : (article as NewsAPIArticle).title;

    if (!headline || seen.has(headline.toLowerCase())) {
      return false;
    }

    seen.add(headline.toLowerCase());
    return true;
  });
}

/**
 * Score articles by importance: recency, source credibility, multi-source mentions, keyword relevance
 */
export function scoreByImportance(articles: (FinnhubArticle | NewsAPIArticle)[], now = Date.now()): number {
  if (!articles || articles.length === 0) return 0;

  // Recency score using first article
  const firstArticle = articles[0];
  const timeMs = isFinnhub(firstArticle)
    ? ((firstArticle as FinnhubArticle).datetime || 0) * 1000
    : new Date((firstArticle as NewsAPIArticle).publishedAt).getTime();

  const hoursSincePublish = (now - timeMs) / (1000 * 60 * 60);
  let recencyScore = 6;
  if (hoursSincePublish < 1) recencyScore = 10;
  else if (hoursSincePublish < 3) recencyScore = 9;
  else if (hoursSincePublish < 6) recencyScore = 8;

  // Source credibility (tier-based)
  const source = isFinnhub(firstArticle)
    ? (firstArticle as FinnhubArticle).source
    : (firstArticle as NewsAPIArticle).source?.name;

  const tier1 = ["Reuters", "Bloomberg", "Wall Street Journal", "Financial Times", "AP"];
  const tier2 = ["CNBC", "MarketWatch", "Seeking Alpha", "Barron's"];

  let credibilityScore = 0;
  if (tier1.some((s) => source?.toLowerCase().includes(s.toLowerCase()))) credibilityScore = 3;
  else if (tier2.some((s) => source?.toLowerCase().includes(s.toLowerCase()))) credibilityScore = 2;

  // Multi-source mentions (more sources = more important)
  const uniqueSources = new Set(
    articles.map((a) =>
      isFinnhub(a) ? (a as FinnhubArticle).source : (a as NewsAPIArticle).source?.name
    )
  ).size;

  let multiSourceScore = 0;
  if (uniqueSources >= 3) multiSourceScore = 3;
  else if (uniqueSources === 2) multiSourceScore = 2;

  // Keyword importance
  const combinedText = articles
    .map((a) =>
      isFinnhub(a)
        ? `${(a as FinnhubArticle).headline} ${(a as FinnhubArticle).summary}`
        : `${(a as NewsAPIArticle).title} ${(a as NewsAPIArticle).description}`
    )
    .join(" ")
    .toLowerCase();

  const highImpactKeywords = [
    "federal reserve", "rate hike", "rate cut", "rate pause", "fed decision",
    "earnings beat", "earnings miss", "market crash", "circuit breaker",
    "s&p 500", "nasdaq", "dow jones", "recession", "gdp", "inflation",
    "jobs report", "unemployment", "treasury yield",
  ];
  const mediumKeywords = [
    "earnings", "guidance", "merger", "acquisition", "bankruptcy", "ipo",
    "dividend", "sector rotation", "yield curve",
  ];

  const highCount = highImpactKeywords.filter((kw) => combinedText.includes(kw)).length;
  const mediumCount = mediumKeywords.filter((kw) => combinedText.includes(kw)).length;
  const keywordScore = Math.min(3, highCount * 1.5 + mediumCount * 0.5);

  // Crypto penalty: crypto-only news scores lower
  const hasCrypto = combinedText.includes("crypto") || combinedText.includes("bitcoin");
  const hasMajorMarket = highImpactKeywords.some((kw) => combinedText.includes(kw));
  const cryptoPenalty = hasCrypto && !hasMajorMarket ? -2 : 0;

  return Math.max(0, Math.min(10, recencyScore + credibilityScore + multiSourceScore + keywordScore + cryptoPenalty));
}

/**
 * Group related articles by topic/keywords
 * Articles about the same topic/company are grouped together for synthesis
 */
export function groupRelatedArticles(articles: (FinnhubArticle | NewsAPIArticle)[]): GroupedNews[] {
  const groups: Map<string, (FinnhubArticle | NewsAPIArticle)[]> = new Map();

  for (const article of articles) {
    const headline = isFinnhub(article)
      ? (article as FinnhubArticle).headline || ""
      : (article as NewsAPIArticle).title || "";

    // Extract key topic from headline
    // Simple heuristic: look for company names or market events
    const topicKey = extractTopicKey(headline);

    if (!groups.has(topicKey)) {
      groups.set(topicKey, []);
    }
    groups.get(topicKey)!.push(article);
  }

  // Convert to GroupedNews array
  const grouped: GroupedNews[] = Array.from(groups.entries()).map(
    ([topic, articles]) => ({
      topic,
      category: inferCategory(articles[0]),
      articles,
      importance: scoreByImportance(articles),
    })
  );

  // Sort by importance (descending)
  grouped.sort((a, b) => b.importance - a.importance);

  return grouped;
}

/**
 * Extract topic key from headline for grouping.
 * Consolidates semantically related terms so articles about the same
 * broad subject land in the same group rather than spawning near-duplicate stories.
 * Priority order: broad macro → company → corporate event → fallback (3 words).
 */
function extractTopicKey(headline: string): string {
  const lower = headline.toLowerCase();

  // 1. Broad macro / market topics — checked first so company-specific news
  //    about, e.g., the Fed still lands in the right bucket
  const topicMappings: [string[], string][] = [
    [["federal reserve", "fed ", "fomc", "powell", "jerome powell", "rate hike", "rate cut", "rate pause", "interest rate"], "federal_reserve"],
    [["inflation", "cpi", "ppi", "consumer price index", "producer price", "core inflation"], "inflation"],
    [["gdp", "gross domestic product", "economic growth", "economic output"], "gdp"],
    [["jobs report", "nonfarm payroll", "unemployment rate", "employment report", "jobless claims"], "employment"],
    [["tariff", "trade war", "trade policy", "import duty", "trade deal", "trade deficit"], "trade_policy"],
    [["s&p 500", "nasdaq composite", "dow jones", "stock market", "market rally", "market selloff", "market decline", "market gains", "broad market", "equities rise", "equities fall"], "broad_market"],
    [["bitcoin", "crypto", "ethereum", "digital asset", "blockchain", "defi", "nft"], "crypto"],
    [["bankruptcy", "chapter 11", "debt restructuring", "debt default", "insolvency"], "bankruptcy"],
    [["merger", "acquisition", "takeover", "buyout", "deal worth", "acquires", "buys out"], "merger_acquisition"],
    [["treasury yield", "bond yield", "yield curve", "10-year", "2-year", "bond market"], "bond_market"],
    [["oil price", "crude oil", "brent crude", "wti crude", "opec", "energy prices"], "energy"],
    [["earnings", "quarterly results", "quarterly earnings", "revenue beat", "revenue miss", "eps beat", "eps miss", "profit beat", "profit miss"], "earnings"],
    [["layoff", "layoffs", "job cuts", "workforce reduction", "headcount reduction"], "layoffs"],
    [["ipo", "initial public offering", "goes public", "stock debut", "listing on"], "ipo"],
  ];

  for (const [keywords, topicKey] of topicMappings) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return topicKey;
    }
  }

  // 2. Company-level clustering — maps well-known companies to a canonical key
  //    so multiple articles about the same company group together
  const companyMappings: [string[], string][] = [
    // Mega-cap tech
    [["apple", "aapl", "iphone", "ipad", "mac ", "tim cook", "apple inc"], "co_apple"],
    [["nvidia", "nvda", "jensen huang", "geforce", "gpu maker", "ai chip"], "co_nvidia"],
    [["microsoft", "msft", "azure", "windows ", "github", "satya nadella", "copilot"], "co_microsoft"],
    [["amazon", "amzn", "aws ", "jeff bezos", "andy jassy", "prime "], "co_amazon"],
    [["alphabet", "google", "googl", "goog ", "youtube", "sundar pichai", "deepmind", "waymo"], "co_alphabet"],
    [["meta ", "facebook", "instagram", "whatsapp", "mark zuckerberg", "threads", "meta platforms"], "co_meta"],
    [["tesla", "tsla", "elon musk", "cybertruck", "ev maker", "gigafactory"], "co_tesla"],
    [["openai", "chatgpt", "gpt-4", "gpt-5", "sam altman", "o1 ", "o3 "], "co_openai"],
    [["anthropic", "claude ai", "claude model"], "co_anthropic"],
    // Financial sector
    [["jpmorgan", "jp morgan", "jpm ", "jamie dimon", "chase bank", "jpmc"], "co_jpmorgan"],
    [["berkshire hathaway", "berkshire", "warren buffett"], "co_berkshire"],
    [["bank of america", "bofa", "bac "], "co_bofa"],
    [["goldman sachs", "goldman ", " gs "], "co_goldman"],
    [["morgan stanley", " ms ", "james gorman", "ted pick"], "co_morganstanley"],
    [["wells fargo", "wfc "], "co_wellsfargo"],
    [["citigroup", "citi ", "citi bank", "jane fraser"], "co_citi"],
    [["blackrock", "larry fink", "blk "], "co_blackrock"],
    [["visa ", "visa inc", " v "], "co_visa"],
    [["mastercard", "ma "], "co_mastercard"],
    // Healthcare / pharma
    [["unitedhealth", "unitedhealthcare", "unh "], "co_unitedhealth"],
    [["pfizer", "pfe "], "co_pfizer"],
    [["johnson & johnson", "j&j", "jnj "], "co_jnj"],
    [["eli lilly", "lly ", "tirzepatide", "mounjaro", "ozempic"], "co_lilly"],
    // Industrial / energy
    [["boeing", " ba ", "737 max", "aircraft maker", "737 ", "787 "], "co_boeing"],
    [["exxon", "exxonmobil", "xom "], "co_exxon"],
    [["chevron", "cvx "], "co_chevron"],
    // Consumer / retail
    [["walmart", "wmt "], "co_walmart"],
    [["target ", " tgt "], "co_target"],
    [["home depot", " hd "], "co_homedepot"],
    [["costco", "cost "], "co_costco"],
    // Entertainment / media
    [["netflix", "nflx"], "co_netflix"],
    [["disney", "dis ", "walt disney", "espn", "hulu"], "co_disney"],
    [["spotify", "spot "], "co_spotify"],
    // Other notable
    [["uber", " lyft ", "rideshare"], "co_rideshare"],
    [["salesforce", "crm "], "co_salesforce"],
    [["oracle", "orcl "], "co_oracle"],
    [["amd", "advanced micro", "lisa su"], "co_amd"],
    [["intel", "intc ", "pat gelsinger"], "co_intel"],
    [["palantir", "pltr "], "co_palantir"],
  ];

  for (const [keywords, companyKey] of companyMappings) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return companyKey;
    }
  }

  // 3. Fallback: use first 3 words (down from 4) to increase grouping odds
  return headline.split(" ").slice(0, 3).join(" ").toLowerCase();
}

/**
 * Infer news category from article content
 */
function inferCategory(article: FinnhubArticle | NewsAPIArticle): "macro" | "earnings" | "markets" | "policy" | "crypto" | "other" {
  const text = isFinnhub(article)
    ? `${(article as FinnhubArticle).headline} ${(article as FinnhubArticle).summary}`
    : `${(article as NewsAPIArticle).title} ${(article as NewsAPIArticle).description}`;

  const lowerText = text.toLowerCase();

  if (lowerText.includes("fed") || lowerText.includes("interest rate") || lowerText.includes("inflation"))
    return "macro";
  if (lowerText.includes("earnings") || lowerText.includes("quarter")) return "earnings";
  if (lowerText.includes("bitcoin") || lowerText.includes("crypto")) return "crypto";
  if (lowerText.includes("sec") || lowerText.includes("regulatory")) return "policy";
  if (
    lowerText.includes("market") ||
    lowerText.includes("stock") ||
    lowerText.includes("bull") ||
    lowerText.includes("bear")
  )
    return "markets";

  return "other";
}

/**
 * Type guard: check if article is from Finnhub
 */
function isFinnhub(article: FinnhubArticle | NewsAPIArticle): article is FinnhubArticle {
  return "headline" in article;
}

/**
 * Format articles for storage (normalize to consistent structure)
 */
export function formatNewsForStorage(articles: (FinnhubArticle | NewsAPIArticle)[]): Array<{
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string;
}> {
  return articles.map((article) => {
    if (isFinnhub(article)) {
      const fh = article as FinnhubArticle;
      return {
        title: fh.headline || "",
        summary: fh.summary || "",
        url: fh.url || "",
        source: fh.source || "Unknown",
        publishedAt: new Date((fh.datetime || 0) * 1000).toISOString(),
      };
    } else {
      const na = article as NewsAPIArticle;
      return {
        title: na.title,
        summary: na.description || "",
        url: na.url,
        source: na.source?.name || "Unknown",
        publishedAt: na.publishedAt,
      };
    }
  });
}
