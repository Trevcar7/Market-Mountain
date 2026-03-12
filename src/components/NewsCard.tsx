import { NewsItem } from "@/lib/news-types";

interface NewsCardProps {
  news: NewsItem;
  variant?: "default" | "featured";
}

export default function NewsCard({ news, variant = "default" }: NewsCardProps) {
  const sentimentColor = {
    positive: "border-emerald-200 bg-emerald-50/50",
    negative: "border-red-200 bg-red-50/50",
    neutral: "border-slate-200 bg-slate-50/50",
  }[news.sentiment || "neutral"];

  const sentimentBadgeColor = {
    positive: "bg-emerald-100 text-emerald-700",
    negative: "bg-red-100 text-red-700",
    neutral: "bg-slate-100 text-slate-700",
  }[news.sentiment || "neutral"];

  const categoryColor = {
    macro: "bg-blue-100 text-blue-700",
    earnings: "bg-purple-100 text-purple-700",
    markets: "bg-amber-100 text-amber-700",
    policy: "bg-teal-100 text-teal-700",
    crypto: "bg-orange-100 text-orange-700",
    other: "bg-slate-100 text-slate-700",
  }[news.category] || "bg-slate-100 text-slate-700";

  const sourceNames = news.sourcesUsed
    .map((src) => src.source)
    .filter((src, i, arr) => arr.indexOf(src) === i) // Remove duplicates
    .join(", ");

  return (
    <article
      className={`flex flex-col gap-4 rounded-lg border p-6 transition-shadow hover:shadow-lg ${sentimentColor}`}
    >
      {/* Headline */}
      <div>
        <h3 className="font-playfair text-xl sm:text-2xl font-bold text-navy-900 mb-3 leading-snug">
          {news.title}
        </h3>
      </div>

      {/* Story body - full text */}
      <div className="prose prose-sm max-w-none">
        <p className="text-slate-700 leading-relaxed whitespace-pre-wrap">
          {news.story}
        </p>
      </div>

      {/* Badges row */}
      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-block px-3 py-1 text-xs font-semibold rounded-full capitalize ${categoryColor}`}
        >
          {news.category}
        </span>
        {news.sentiment && (
          <span
            className={`inline-block px-3 py-1 text-xs font-semibold rounded-full ${sentimentBadgeColor}`}
          >
            {news.sentiment.charAt(0).toUpperCase() + news.sentiment.slice(1)}
          </span>
        )}
      </div>

      {/* Tickers row */}
      {news.relatedTickers && news.relatedTickers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {news.relatedTickers.map((ticker) => (
            <span
              key={ticker}
              className="px-2.5 py-1 bg-slate-200 text-slate-700 rounded text-xs font-mono font-semibold"
            >
              {ticker}
            </span>
          ))}
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-slate-200/50" />

      {/* Metadata footer */}
      <div className="flex items-center justify-between text-xs text-slate-600">
        <time dateTime={news.publishedAt}>
          {new Date(news.publishedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      </div>

      {/* Source attribution */}
      <div className="text-xs text-slate-600 pt-2 border-t border-slate-200/50">
        <p>
          <span className="text-slate-500">Based on analysis of </span>
          <span className="font-medium text-slate-700">{sourceNames}</span>
        </p>
      </div>
    </article>
  );
}
