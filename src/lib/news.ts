import {
  FinnhubArticle,
  NewsAPIArticle,
  GroupedNews,
  RawNews,
} from "./news-types";

/**
 * Financial market keywords for filtering relevance
 */
const MARKET_KEYWORDS = [
  "federal reserve",
  "fed",
  "rate hike",
  "rate cut",
  "interest rate",
  "inflation",
  "gdp",
  "earnings",
  "earnings beat",
  "earnings miss",
  "market crash",
  "market rally",
  "bull market",
  "bear market",
  "recession",
  "supply chain",
  "sector rotation",
  "ipo",
  "merger",
  "acquisition",
  "bankruptcy",
  "dividend",
  "stock split",
  "market volatility",
  "trading halt",
  "circuit breaker",
  "vix",
  "inflation data",
  "jobs report",
  "employment",
  "unemployment",
  "cpi",
  "ppi",
  "treasury",
  "yield curve",
  "bond market",
  "crypto",
  "bitcoin",
  "ethereum",
  "regulatory",
  "sec",
  "fomc",
  "elon musk",
  "berkshire hathaway",
  "warren buffett",
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
 * Fetch news from NewsAPI
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
 * Filter articles by relevance to financial markets
 * Checks headlines, descriptions, and URLs against keyword lists
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

    const combinedText = `${headline} ${summary}`.toLowerCase();

    // Check if blocked domain
    if (BLOCKED_DOMAINS.some((domain) => url.toLowerCase().includes(domain))) {
      return false;
    }

    // Check for market relevance keywords
    const isRelevant = MARKET_KEYWORDS.some((keyword) =>
      combinedText.includes(keyword.toLowerCase())
    );

    return isRelevant;
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
  let keywordScore = Math.min(3, highCount * 1.5 + mediumCount * 0.5);

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
 * Extract topic key from headline for grouping
 */
function extractTopicKey(headline: string): string {
  const keywords = [
    "federal reserve",
    "fed",
    "rate",
    "inflation",
    "gdp",
    "earnings",
    "bankruptcy",
    "merger",
    "acquisition",
  ];

  for (const keyword of keywords) {
    if (headline.toLowerCase().includes(keyword)) {
      return keyword;
    }
  }

  // Default: use first 3-5 words as topic
  const words = headline.split(" ").slice(0, 4).join(" ").toLowerCase();
  return words;
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
