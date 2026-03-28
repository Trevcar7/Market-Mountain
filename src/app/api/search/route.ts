import { NextRequest, NextResponse } from "next/server";
import { getAllArticles, getArticle } from "@/lib/articles";
import { getRedisClient } from "@/lib/redis";
import type { NewsCollection, NewsItem } from "@/lib/news-types";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";

export const runtime = "nodejs";

interface SearchResult {
  type: "article" | "news";
  id: string;
  title: string;
  excerpt: string;
  url: string;
  date: string;
  category?: string;
  ticker?: string;
  relevance: number;
}

/**
 * Simple text relevance scorer — counts keyword matches in title, excerpt, and body.
 * Title matches are weighted 3x, ticker matches 5x.
 */
function scoreRelevance(
  query: string,
  title: string,
  excerpt: string,
  body: string,
  ticker?: string
): number {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return 0;

  let score = 0;
  const titleLower = title.toLowerCase();
  const excerptLower = excerpt.toLowerCase();
  const bodyLower = body.toLowerCase();
  const tickerLower = ticker?.toLowerCase() ?? "";

  for (const term of terms) {
    // Ticker exact match (highest weight)
    if (tickerLower && tickerLower === term) score += 50;
    else if (tickerLower && tickerLower.includes(term)) score += 25;

    // Title matches (high weight)
    if (titleLower.includes(term)) score += 30;

    // Excerpt matches (medium weight)
    if (excerptLower.includes(term)) score += 15;

    // Body matches (low weight, but catch content-only terms)
    if (bodyLower.includes(term)) score += 5;
  }

  return score;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  const type = searchParams.get("type") ?? "all"; // all | articles | news
  const category = searchParams.get("category") ?? "";

  if (!query || query.length < 2) {
    return NextResponse.json({ results: [], query });
  }

  const results: SearchResult[] = [];

  // Search articles (filesystem)
  if (type === "all" || type === "articles") {
    const articles = getAllArticles();
    for (const meta of articles) {
      const article = getArticle(meta.slug);
      const body = article?.content ?? "";
      const relevance = scoreRelevance(query, meta.title, meta.excerpt, body, meta.ticker);

      if (relevance > 0) {
        if (category && !meta.tags?.some((t) => t.toLowerCase().includes(category.toLowerCase()))) {
          continue;
        }
        results.push({
          type: "article",
          id: meta.slug,
          title: meta.title,
          excerpt: meta.excerpt,
          url: `/post/${meta.slug}`,
          date: meta.date,
          category: meta.tags?.[0],
          ticker: meta.ticker,
          relevance,
        });
      }
    }
  }

  // Search news (KV)
  if (type === "all" || type === "news") {
    const kv = getRedisClient();
    if (kv) {
      try {
        const data = await kv.get<NewsCollection>("news");
        const stories = (data?.news ?? []).filter(
          (n) => new Date(n.publishedAt).getTime() >= MARCH_13_CUTOFF_MS
        );

        for (const story of stories) {
          const ticker = story.relatedTickers?.[0];
          const relevance = scoreRelevance(
            query,
            story.title,
            story.whyThisMatters ?? "",
            story.story,
            ticker
          );

          if (relevance > 0) {
            if (category && story.category !== category.toLowerCase()) {
              continue;
            }
            results.push({
              type: "news",
              id: story.id,
              title: story.title,
              excerpt: story.whyThisMatters ?? story.story.substring(0, 160),
              url: `/news/${story.id}`,
              date: story.publishedAt,
              category: story.category,
              ticker,
              relevance,
            });
          }
        }
      } catch {
        // Non-fatal — return article results only
      }
    }
  }

  // Sort by relevance (highest first), then by date (newest first)
  results.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  return NextResponse.json(
    { results: results.slice(0, 20), query, total: results.length },
    { headers: { "Cache-Control": "public, s-maxage=60" } }
  );
}
