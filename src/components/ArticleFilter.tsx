"use client";

import { useState, useMemo } from "react";
import type { ArticleMeta } from "@/lib/article-types";
import ArticleCard from "./ArticleCard";

interface ArticleFilterProps {
  articles: ArticleMeta[];
}

export default function ArticleFilter({ articles }: ArticleFilterProps) {
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // Extract unique tags from all articles
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    articles.forEach((a) => a.tags?.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [articles]);

  const filtered = selectedTag
    ? articles.filter((a) => a.tags?.includes(selectedTag))
    : articles;

  const featured = filtered[0];
  const rest = filtered.slice(1);

  return (
    <>
      {/* Tag filter pills */}
      {allTags.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-8">
          <button
            onClick={() => setSelectedTag(null)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-150 ${
              selectedTag === null
                ? "bg-navy-900 text-white"
                : "bg-surface-2 text-text-muted hover:bg-navy-100 hover:text-navy-900"
            }`}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-150 ${
                selectedTag === tag
                  ? "bg-navy-900 text-white"
                  : "bg-surface-2 text-text-muted hover:bg-navy-100 hover:text-navy-900"
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-text-muted text-center py-20">
          No articles published yet — check back soon.
        </p>
      ) : (
        <>
          {featured && (
            <div className="mb-6 sm:mb-8">
              <ArticleCard article={featured} featured />
            </div>
          )}

          {rest.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
              {rest.map((article) => (
                <ArticleCard key={article.slug} article={article} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
