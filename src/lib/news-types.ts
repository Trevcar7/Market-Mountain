/**
 * Type definitions for news aggregation feature
 */

export interface NewsSource {
  title: string;
  url: string;
  source: string; // e.g., "Reuters", "Bloomberg", "CNBC"
}

export interface NewsItem {
  id: string; // UUID or hash of story
  title: string;
  story: string; // Main synthesized narrative
  category: "macro" | "earnings" | "markets" | "policy" | "crypto" | "other";
  publishedAt: string; // ISO 8601 timestamp
  importance: number; // 1-10 score
  sentiment?: "positive" | "negative" | "neutral";
  relatedTickers?: string[]; // e.g., ["SPY", "^GSPC", "BTC-USD"]
  sourcesUsed: NewsSource[]; // Original articles combined for synthesis
  synthesizedBy: "Gemini"; // Could be extended for other models
  factCheckScore: number; // 0-100, confidence in accuracy
  verifiedClaims: string[]; // List of specific facts verified
  toneMatch?: string; // e.g., "Trevor's voice - analytical, measured"
  failureReason?: string; // If story was rejected
}

export interface NewsCollection {
  lastUpdated: string; // ISO 8601 timestamp
  source: string; // "Finnhub + NewsAPI (synthesized via Gemini)"
  news: NewsItem[];
  meta: {
    totalCount: number;
    nextUpdate: string;
    archiveUrl?: string;
  };
}

export interface ArchivedNewsCollection {
  lastUpdated: string;
  archivedNews: Array<
    NewsItem & {
      archivedAt: string;
    }
  >;
  meta: {
    totalCount: number;
    oldestStory: string;
    newestStory: string;
  };
}

export interface FinnhubArticle {
  headline?: string;
  summary?: string;
  url?: string;
  source?: string;
  datetime?: number; // Unix timestamp
  category?: string;
  image?: string;
  related?: string[];
}

export interface NewsAPIArticle {
  source: {
    id: string | null;
    name: string;
  };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string; // ISO 8601
  content: string;
}

export interface FactCheckResult {
  claim: string;
  verified: boolean;
  confidence: number; // 0-100
  sources?: string[]; // URLs of fact-check articles
  explanation?: string;
}

export interface SynthesisInput {
  relatedArticles: (FinnhubArticle | NewsAPIArticle)[];
  category: NewsItem["category"];
  importance: number;
}

export interface RawNews {
  finnhub: FinnhubArticle[];
  newsapi: NewsAPIArticle[];
}

export interface GroupedNews {
  topic: string; // e.g., "Federal Reserve Rate Decision"
  category: NewsItem["category"];
  articles: Array<FinnhubArticle | NewsAPIArticle>;
  importance: number;
}

// Type guards
export function isFinnhubArticle(article: unknown): article is FinnhubArticle {
  return (
    typeof article === "object" &&
    article !== null &&
    ("headline" in article || "summary" in article)
  );
}

export function isNewsAPIArticle(article: unknown): article is NewsAPIArticle {
  return (
    typeof article === "object" &&
    article !== null &&
    "source" in article &&
    typeof (article as any).source === "object" &&
    "name" in (article as any).source
  );
}

export function isNewsItem(item: unknown): item is NewsItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "id" in item &&
    "title" in item &&
    "story" in item &&
    "category" in item
  );
}
