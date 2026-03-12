"use client";

import { useEffect, useState } from "react";
import NewsCard from "./NewsCard";
import { NewsItem } from "@/lib/news-types";

interface NewsSectionProps {
  initialNews?: NewsItem[];
  limit?: number;
  showCategories?: boolean;
  showSort?: boolean;
}

type SortOption = "recent" | "importance" | "sentiment";
type CategoryFilter = "all" | "macro" | "earnings" | "markets" | "policy" | "crypto";

export default function NewsSection({
  initialNews = [],
  limit = 50,
  showCategories = true,
  showSort = true,
}: NewsSectionProps) {
  const [news, setNews] = useState<NewsItem[]>(initialNews);
  const [loading, setLoading] = useState(!initialNews.length);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [category, setCategory] = useState<CategoryFilter>("all");

  // Fetch news from /data/news.json
  useEffect(() => {
    const fetchNews = async () => {
      try {
        setLoading(true);
        const response = await fetch("/data/news.json", {
          headers: { "Cache-Control": "max-age=300" }, // 5 min cache
        });

        if (!response.ok) throw new Error("Failed to fetch news");

        const data = await response.json();
        setNews(data.news || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setNews([]);
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
    // Refetch every 5 minutes
    const interval = setInterval(fetchNews, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Filter and sort
  let filtered = news;

  // Filter by category
  if (category !== "all") {
    filtered = filtered.filter((item) => item.category === category);
  }

  // Sort
  filtered = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "importance":
        return b.importance - a.importance;
      case "sentiment":
        const sentimentOrder = { positive: 3, neutral: 2, negative: 1 };
        return (
          (sentimentOrder[b.sentiment || "neutral"] ?? 0) -
          (sentimentOrder[a.sentiment || "neutral"] ?? 0)
        );
      case "recent":
      default:
        return (
          new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
        );
    }
  });

  // Limit results
  filtered = filtered.slice(0, limit);

  return (
    <div className="w-full">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        {showCategories && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setCategory("all")}
              className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                category === "all"
                  ? "bg-accent-500 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              All
            </button>
            {(
              ["macro", "earnings", "markets", "policy", "crypto"] as const
            ).map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`px-3 py-1.5 text-sm font-medium rounded transition-colors capitalize ${
                  category === cat
                    ? "bg-accent-500 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {showSort && (
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded bg-white text-slate-700 hover:border-slate-400"
          >
            <option value="recent">Most Recent</option>
            <option value="importance">Most Important</option>
            <option value="sentiment">Sentiment</option>
          </select>
        )}
      </div>

      {/* Status messages */}
      {loading && (
        <div className="text-center py-12">
          <div className="inline-block">
            <div className="animate-spin h-8 w-8 border-4 border-slate-300 border-t-accent-500 rounded-full"></div>
          </div>
          <p className="mt-4 text-slate-600">Loading market news...</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          <p className="font-semibold">Error loading news</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-12 text-slate-600">
          <p className="text-lg">No news articles found</p>
          <p className="text-sm mt-1">Check back soon for market updates</p>
        </div>
      )}

      {/* News grid */}
      {!loading && !error && filtered.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((newsItem) => (
            <NewsCard key={newsItem.id} news={newsItem} />
          ))}
        </div>
      )}

      {/* Result count */}
      {!loading && !error && filtered.length > 0 && (
        <p className="mt-6 text-sm text-slate-500 text-center">
          Showing {filtered.length} of {news.length} news articles
        </p>
      )}
    </div>
  );
}
