"use client";

import { useEffect, useState } from "react";
import NewsCard from "./NewsCard";
import { NewsItem } from "@/lib/news-types";
import { jaccardSimilarity } from "@/lib/text-similarity";

interface NewsSectionProps {
  initialNews?: NewsItem[];
  limit?: number;
  showCategories?: boolean;
  showSort?: boolean;
  noFeatured?: boolean;
}

type SortOption = "recent" | "importance" | "sentiment";
type CategoryFilter = "all" | "macro" | "earnings" | "markets" | "policy" | "crypto";

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs === 1) return "1 hour ago";
  return `${hrs} hours ago`;
}

// ── Topic-cluster deduplication ────────────────────────────────────────────────
// Prevents simultaneous topic clusters from dominating the visible feed.
// The hero (first story after sort) is locked in. Any subsequent story that is
// BOTH highly similar to the hero AND published within TIME_WINDOW_HOURS is
// deferred to the back of the list — not deleted, just deprioritised.
//
// Similarity is scored across three independent signals; the highest wins:
//   1. topicKey match   → 0.80  (same editorial cluster: e.g. "energy", "fed_macro")
//   2. ticker overlap   → up to 0.70  (same assets: e.g. USO, XLE appear in both)
//   3. title Jaccard    → up to 0.90  (shared keywords after stop-word removal)
//
// Threshold : 0.75  (any single signal can exceed this on its own)
// Time window: 6 hours  (stories further apart are always shown regardless)
//
// This means:
//   "Iran Conflict Pushes Oil Toward $100" (topicKey=energy, tickers=[USO, OIL])
//   "Middle East Tensions Drive Crude Rally" (topicKey=energy, tickers=[USO, OIL])
//   → topicKey match → score 0.80 ≥ 0.75, within 6h → deferred ✓
//
//   "Oil Breaks $100 as Iran Conflict Escalates" — published 8h later
//   → score 0.80 ≥ 0.75 BUT timeDiff 8h > 6h → displayed ✓ (evolving coverage)
//
//   "Airline Stocks Fall as Oil Surge Hits Transport Sector"
//   → topicKey=markets ≠ energy, tickers=[DAL, UAL] ≠ [USO, OIL], low title overlap
//   → score < 0.75 → displayed ✓ (secondary market reaction)
// ──────────────────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.75;
const TIME_WINDOW_HOURS    = 6;

function storySimilarity(hero: NewsItem, candidate: NewsItem): number {
  let score = 0;

  // Signal 1 — topicKey cluster match (0.80)
  if (
    hero.topicKey &&
    candidate.topicKey &&
    hero.topicKey === candidate.topicKey
  ) {
    score = Math.max(score, 0.80);
  }

  // Signal 2 — shared ticker overlap (up to 0.70)
  const heroTickers = new Set(hero.relatedTickers ?? []);
  const candTickers = candidate.relatedTickers ?? [];
  if (heroTickers.size > 0 && candTickers.length > 0) {
    const shared = candTickers.filter((t) => heroTickers.has(t)).length;
    if (shared > 0) {
      const tickerScore =
        shared / Math.min(heroTickers.size, candTickers.length);
      score = Math.max(score, tickerScore * 0.70);
    }
  }

  // Signal 3 — title word overlap via Jaccard similarity (up to 0.90)
  const jaccard = jaccardSimilarity(hero.title, candidate.title);
  score = Math.max(score, jaccard * 0.90);

  return score;
}

/**
 * Reorder `sorted` so that stories simultanously similar to the hero
 * (sorted[0]) appear after topically distinct stories.
 *
 * - Stories beyond TIME_WINDOW_HOURS of the hero are always kept in place
 *   (evolving coverage / new developments are not affected).
 * - Deferred stories are appended at the end — nothing is discarded.
 */
function deduplicateForDisplay(sorted: NewsItem[]): NewsItem[] {
  if (sorted.length <= 1) return sorted;

  const hero    = sorted[0];
  const heroMs  = new Date(hero.publishedAt).getTime();
  const windowMs = TIME_WINDOW_HOURS * 60 * 60 * 1000;

  const displayed: NewsItem[] = [hero];
  const deferred:  NewsItem[] = [];

  for (const candidate of sorted.slice(1)) {
    const timeDiff   = Math.abs(new Date(candidate.publishedAt).getTime() - heroMs);
    const similarity = storySimilarity(hero, candidate);

    // Suppress only when BOTH conditions hold simultaneously
    if (timeDiff <= windowMs && similarity >= SIMILARITY_THRESHOLD) {
      deferred.push(candidate);
    } else {
      displayed.push(candidate);
    }
  }

  // Deferred stories follow the diverse ones — still reachable by scrolling
  return [...displayed, ...deferred];
}

export default function NewsSection({
  initialNews = [],
  limit = 50,
  showCategories = true,
  showSort = true,
  noFeatured = false,
}: NewsSectionProps) {
  const [news, setNews] = useState<NewsItem[]>(initialNews);
  const [loading, setLoading] = useState(!initialNews.length);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    const fetchNews = async () => {
      try {
        setLoading(true);
        const response = await fetch("/api/news");

        if (!response.ok) throw new Error("Failed to fetch news");

        const data = await response.json();
        setNews(data.news || []);
        setLastUpdated(data.lastUpdated || null);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setNews([]);
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
    // Refetch every 2 minutes (aligns with 90s CDN cache TTL)
    const interval = setInterval(fetchNews, 2 * 60 * 1000);
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

  // Topic-cluster deduplication — only in default editorial ordering.
  // Skipped when user has manually chosen importance or sentiment sort,
  // since they expect full unfiltered results in those modes.
  if (sortBy === "recent") {
    filtered = deduplicateForDisplay(filtered);
  }

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
        <>
          <div className="mb-6 sm:mb-8">
            <div className="animate-pulse rounded-xl bg-navy-900/10 h-[360px] w-full" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse rounded-lg border border-border overflow-hidden">
                <div className="bg-slate-200 aspect-video w-full" />
                <div className="p-5 space-y-3">
                  <div className="h-2 bg-slate-200 rounded w-16" />
                  <div className="h-4 bg-slate-200 rounded w-full" />
                  <div className="h-4 bg-slate-200 rounded w-3/4" />
                  <div className="h-3 bg-slate-100 rounded w-1/2 mt-4" />
                </div>
              </div>
            ))}
          </div>
        </>
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

      {/* News: grid-only (noFeatured) or featured + grid (default) */}
      {!loading && !error && filtered.length > 0 && (
        noFeatured ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
            {filtered.map((newsItem) => (
              <NewsCard key={newsItem.id} news={newsItem} />
            ))}
          </div>
        ) : (
          <>
            {/* Featured first story */}
            <div className="mb-6 sm:mb-8">
              <NewsCard news={filtered[0]} variant="featured" />
            </div>

            {/* Remaining stories in grid */}
            {filtered.length > 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
                {filtered.slice(1).map((newsItem) => (
                  <NewsCard key={newsItem.id} news={newsItem} />
                ))}
              </div>
            )}
          </>
        )
      )}

    </div>
  );
}
