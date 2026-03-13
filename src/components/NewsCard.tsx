import { NewsItem } from "@/lib/news-types";
import Image from "next/image";
import Link from "next/link";

interface NewsCardProps {
  news: NewsItem;
  variant?: "default" | "featured";
}

const categoryGradients: Record<string, string> = {
  macro: "from-blue-900 via-blue-950 to-navy-900",
  earnings: "from-purple-900 via-purple-950 to-navy-900",
  markets: "from-amber-900 via-amber-950 to-navy-900",
  policy: "from-teal-900 via-teal-950 to-navy-900",
  crypto: "from-orange-900 via-orange-950 to-navy-900",
  other: "from-slate-800 via-slate-900 to-navy-900",
};

const categoryLabels: Record<string, string> = {
  macro: "Macro Economics",
  earnings: "Earnings",
  markets: "Markets",
  policy: "Policy & Economics",
  crypto: "Crypto",
  other: "Market News",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function NewsCard({ news, variant = "default" }: NewsCardProps) {
  const href = `/news/${news.id}`;
  const gradient = categoryGradients[news.category] ?? categoryGradients.other;
  const categoryLabel = categoryLabels[news.category] ?? "Market News";

  // Excerpt: first sentence of the story
  const excerpt = news.story.split(/(?<=[.!?])\s/)[0] || news.story.substring(0, 180);

  if (variant === "featured") {
    return (
      <Link
        href={href}
        className="group block relative overflow-hidden rounded-xl bg-navy-900 shadow-lg hover:shadow-2xl transition-all duration-300"
        style={{ minHeight: 360 }}
      >
        {/* Background: photo if available, else gradient */}
        {news.imageUrl ? (
          <Image
            src={news.imageUrl}
            alt={news.title}
            fill
            className="object-cover opacity-40 group-hover:opacity-50 group-hover:scale-105 transition-all duration-500"
            sizes="(max-width: 768px) 100vw, 66vw"
          />
        ) : (
          <div
            className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-60 group-hover:opacity-70 transition-opacity duration-500`}
          />
        )}
        {/* Dark overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-navy-950 via-navy-950/60 to-transparent" />

        {/* Content at bottom */}
        <div className="absolute inset-0 flex flex-col justify-end p-7 sm:p-10">
          <span className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-300 bg-white/10 px-2 py-0.5 rounded mb-4 w-fit">
            {categoryLabel}
          </span>

          <h2
            className="text-white text-2xl sm:text-[1.75rem] font-bold leading-tight mb-3 group-hover:text-accent-300 transition-colors duration-200"
            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
          >
            {news.title}
          </h2>

          {/* Why this matters — featured variant */}
          {news.whyThisMatters ? (
            <div className="mb-3 hidden sm:flex items-start gap-2">
              <span className="shrink-0 text-[9px] font-bold tracking-widest uppercase text-accent-400 mt-0.5">
                Why it matters
              </span>
              <p className="text-white/65 text-xs leading-relaxed line-clamp-2">
                {news.whyThisMatters}
              </p>
            </div>
          ) : (
            <p className="text-white/55 text-sm leading-relaxed mb-5 line-clamp-2 hidden sm:block">
              {excerpt}
            </p>
          )}

          <div className="flex items-center gap-3 text-white/40 text-[11px] tracking-wide">
            <time dateTime={news.publishedAt}>{formatDate(news.publishedAt)}</time>
            <span className="ml-auto flex items-center gap-1.5 text-accent-400 text-xs font-semibold group-hover:gap-2.5 transition-all duration-200">
              Read story
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className="group flex flex-col rounded-lg bg-card border border-border hover:border-navy-200 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 overflow-hidden"
    >
      {/* Cover: photo if available, else gradient — 16:9 */}
      <div className={`relative w-full aspect-video overflow-hidden bg-gradient-to-br ${gradient}`}>
        {news.imageUrl && (
          <Image
            src={news.imageUrl}
            alt={news.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        )}
        {/* Category label in bottom-left */}
        <div className="absolute inset-0 flex items-end p-3">
          <span className="text-[10px] font-semibold tracking-widest uppercase text-white/70">
            {categoryLabel}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col flex-1 p-4 sm:p-5">
        <span className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-700 bg-accent-100 px-2 py-0.5 rounded mb-2.5 w-fit">
          {categoryLabel}
        </span>

        <h3
          className="text-navy-900 text-[1.05rem] font-bold leading-snug mb-2 group-hover:text-navy-600 transition-colors duration-150 line-clamp-2 sm:line-clamp-3"
          style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
        >
          {news.title}
        </h3>

        <p className="text-text-muted text-sm leading-relaxed line-clamp-2 flex-1 hidden sm:block">
          {excerpt}
        </p>

        {/* Why this matters strip */}
        {news.whyThisMatters && (
          <div className="mt-3 pt-3 border-t border-border/60">
            <div className="flex items-start gap-1.5">
              <span className="shrink-0 text-[9px] font-bold tracking-widest uppercase text-accent-600 mt-0.5">
                Why it matters
              </span>
              <p className="text-text-muted text-xs leading-relaxed line-clamp-2">
                {news.whyThisMatters}
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 text-text-light text-[11px] tracking-wide mt-3 pt-3 border-t border-border/60">
          <time dateTime={news.publishedAt}>{formatDate(news.publishedAt)}</time>
        </div>
      </div>
    </Link>
  );
}
