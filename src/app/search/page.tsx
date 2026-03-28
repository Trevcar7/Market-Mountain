"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import type { SearchResult } from "@/lib/search-types";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function SearchResults() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      setTotal(0);
      return;
    }

    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((data) => {
        setResults(data.results ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(() => { setResults([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [query]);

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
        <h1 className="text-2xl font-serif font-bold text-text mb-2">
          Search Results
        </h1>
        {query && (
          <p className="text-sm text-text-muted mb-8">
            {loading ? "Searching..." : `${total} result${total !== 1 ? "s" : ""} for "${query}"`}
          </p>
        )}

        {!loading && results.length === 0 && query.length >= 2 && (
          <div className="text-center py-16">
            <p className="text-text-muted">No results found for &ldquo;{query}&rdquo;</p>
            <p className="text-sm text-text-light mt-2">
              Try searching for a ticker (FSLR), topic (inflation), or keyword.
            </p>
          </div>
        )}

        <div className="space-y-4">
          {results.map((result) => (
            <Link
              key={`${result.type}-${result.id}`}
              href={result.url}
              className="block bg-card rounded-lg border border-border p-5 hover:border-accent-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded ${
                    result.type === "article"
                      ? "bg-accent-100 text-accent-700"
                      : "bg-navy-100 text-navy-600"
                  }`}
                >
                  {result.type === "article" ? "Article" : "News"}
                </span>
                {result.ticker && (
                  <span className="text-[11px] font-bold text-accent-600">${result.ticker}</span>
                )}
                {result.category && (
                  <span className="text-[11px] text-text-light">{result.category}</span>
                )}
                <span className="text-[11px] text-text-light ml-auto">{formatDate(result.date)}</span>
              </div>
              <h2 className="text-base font-semibold text-text mb-1">{result.title}</h2>
              <p className="text-sm text-text-muted line-clamp-2">{result.excerpt}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-surface" />}>
      <SearchResults />
    </Suspense>
  );
}
