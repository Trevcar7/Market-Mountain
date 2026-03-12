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
 * Score articles by importance based on recency and source credibility
 */
export function scoreByImportance(articles: (FinnhubArticle | NewsAPIArticle)[], now = Date.now()): number {
  const article = articles[0]; // Score first article
  if (!article) return 0;

  const timeMs = isFinnhub(article)
    ? ((article as FinnhubArticle).datetime || 0) * 1000
    : new Date((article as NewsAPIArticle).publishedAt).getTime();

  const hoursSincePublish = (now - timeMs) / (1000 * 60 * 60);

  // Recency score: 10 if <1 hour old, 8 if <6 hours, 6 if <24 hours
  let recencyScore = 6;
  if (hoursSincePublish < 1) recencyScore = 10;
  else if (hoursSincePublish < 6) recencyScore = 8;

  // Source credibility (rough estimate)
  const source = isFinnhub(article)
    ? (article as FinnhubArticle).source
    : (article as NewsAPIArticle).source?.name;

  const credibleSources = [
    "Reuters",
    "Bloomberg",
    "AP",
    "CNBC",
    "Wall Street Journal",
    "Financial Times",
    "MarketWatch",
  ];
  const credibilityScore = credibleSources.some((s) =>
    source?.toLowerCase().includes(s.toLowerCase())
  )
    ? 2
    : 0;

  return Math.min(10, recencyScore + credibilityScore);
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
