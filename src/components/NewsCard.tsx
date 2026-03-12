import { NewsItem } from "@/lib/news-types";
import Link from "next/link";

interface NewsCardProps {
  news: NewsItem;
  variant?: "default" | "featured";
}

export default function NewsCard({ news, variant = "default" }: NewsCardProps) {
  const isExternal = true; // News items link to external sources

  const sentimentColor = {
    positive: "bg-emerald-50 border-emerald-200",
    negative: "bg-red-50 border-red-200",
    neutral: "bg-slate-50 border-slate-200",
  }[news.sentiment || "neutral"];

  const sentimentBadgeColor = {
    positive: "bg-emerald-100 text-emerald-700",
    negative: "bg-red-100 text-red-700",
    neutral: "bg-slate-100 text-slate-700",
  }[news.sentiment || "neutral"];

  const importanceBadgeColor = {
    high: news.importance >= 8 ? "bg-accent-100 text-accent-700" : "",
    medium:
      news.importance >= 5 && news.importance < 8
        ? "bg-blue-100 text-blue-700"
        : "",
    low: news.importance < 5 ? "bg-slate-100 text-slate-700" : "",
  };

  const badges = [];
  if (news.importance >= 8) {
    badges.push({
      text: `Importance: ${news.importance}/10`,
      color: "bg-accent-100 text-accent-700",
    });
  }
  if (news.sentiment) {
    badges.push({
      text: news.sentiment.charAt(0).toUpperCase() + news.sentiment.slice(1),
      color: sentimentBadgeColor,
    });
  }
  if (news.factCheckScore >= 85) {
    badges.push({
      text: `Verified: ${news.factCheckScore}%`,
      color: "bg-green-100 text-green-700",
    });
  }

  return (
    <article
      className={`flex flex-col gap-3 rounded-lg border p-4 transition-shadow hover:shadow-md ${sentimentColor}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h3 className="font-playfair text-lg font-semibold text-navy-900 line-clamp-2">
            {news.title}
          </h3>
          <p className="text-sm text-slate-600 mt-1">
            {news.sourcesUsed[0]?.source || "Financial News"}
          </p>
        </div>

        {/* External link icon */}
        <a
          href={news.sourcesUsed[0]?.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 text-slate-400 hover:text-accent-500 transition-colors"
          aria-label="Read original story"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
            />
          </svg>
        </a>
      </div>

      {/* Story excerpt */}
      <p className="text-sm text-slate-700 line-clamp-3">{news.story}</p>

      {/* Badges */}
      <div className="flex flex-wrap gap-2 mt-1">
        {badges.map((badge, i) => (
          <span
            key={i}
            className={`inline-block px-2.5 py-1 text-xs font-medium rounded ${badge.color}`}
          >
            {badge.text}
          </span>
        ))}
      </div>

      {/* Footer: metadata */}
      <div className="flex items-center justify-between text-xs text-slate-500 mt-2 pt-2 border-t border-slate-200/50">
        <div className="flex gap-2">
          <span className="capitalize">{news.category}</span>
          <span>•</span>
          <time dateTime={news.publishedAt}>
            {new Date(news.publishedAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </div>

        {/* Related tickers */}
        {news.relatedTickers && news.relatedTickers.length > 0 && (
          <div className="flex gap-1">
            {news.relatedTickers.slice(0, 3).map((ticker) => (
              <span
                key={ticker}
                className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded text-xs font-mono"
              >
                {ticker}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Sources used */}
      {news.sourcesUsed.length > 1 && (
        <div className="text-xs text-slate-500 mt-1 pt-1 border-t border-slate-200/50">
          <span className="text-slate-400">Sources: </span>
          {news.sourcesUsed.map((src, i) => (
            <span key={i}>
              <a
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-600 hover:text-accent-500 underline"
              >
                {src.source}
              </a>
              {i < news.sourcesUsed.length - 1 && ", "}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
