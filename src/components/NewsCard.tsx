import { NewsItem, MarketImpactItem } from "@/lib/news-types";
import { categoryLabels, categoryGradients } from "@/lib/category-config";
import Link from "next/link";

interface NewsCardProps {
  news: NewsItem;
  variant?: "default" | "featured";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Compact market-impact strip: "OIL +4.1% · S&P −1.2% · 10Y +8bps"
 * Shown below article title on both card variants when marketImpact is present.
 */
function MarketImpactStrip({ items }: { items: MarketImpactItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2">
      {items.slice(0, 3).map((item, i) => (
        <span
          key={i}
          className={`text-[10px] font-bold tracking-wide tabular-nums ${
            item.direction === "up"
              ? "text-emerald-600"
              : item.direction === "down"
              ? "text-red-500"
              : "text-slate-400"
          }`}
        >
          {item.asset} {item.change}
          {i < Math.min(items.length, 3) - 1 && (
            <span className="text-border/80 font-normal ml-1.5">·</span>
          )}
        </span>
      ))}
    </div>
  );
}

export default function NewsCard({ news, variant = "default" }: NewsCardProps) {
  const href = `/news/${news.id}`;
  const gradient = categoryGradients[news.category] ?? categoryGradients.other;
  const categoryLabel = categoryLabels[news.category] ?? "Market News";

  // Excerpt: first sentence of the story body (skip ## headings, hashtags, and bullets)
  const cleanStory = news.story
    .replace(/^## .+$/gm, "")           // strip section headings
    .replace(/^[•\-\*]\s+.+$/gm, "")   // strip bullet lines (e.g., leaked MARKET_IMPACT)
    .replace(/(?<!\w)#([A-Za-z]\w*)/g, "$1") // strip hashtags
    .replace(/\n{2,}/g, "\n")           // collapse blank lines
    .trim();
  const firstSentence = cleanStory.split(/(?<=[.!?])\s+/)[0] ?? "";
  const excerpt = firstSentence.length > 40 ? firstSentence : cleanStory.substring(0, 180);

  if (variant === "featured") {
    return (
      <Link
        href={href}
        className="group block relative overflow-hidden rounded-xl bg-navy-900 shadow-lg hover:shadow-2xl transition-all duration-300 aspect-[16/9] min-h-[280px]"
      >
        {/* Background: category gradient */}
        <div
          className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-60 group-hover:opacity-70 transition-opacity duration-500`}
        />
        {/* Dark overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-navy-950 via-navy-950/60 to-transparent" />

        {/* Content at bottom */}
        <div className="absolute inset-0 flex flex-col justify-end p-7 sm:p-10">
          <span className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-300 bg-white/10 px-2 py-0.5 rounded mb-4 w-fit">
            {categoryLabel}
          </span>

          <h2
            className="text-white text-2xl sm:text-[1.75rem] font-bold leading-tight mb-2 group-hover:text-accent-300 transition-colors duration-200 font-playfair"
          >
            {news.title}
          </h2>

          {/* Market impact strip — featured */}
          {news.marketImpact && news.marketImpact.length > 0 && (
            <div className="mb-2">
              <MarketImpactStrip items={news.marketImpact} />
            </div>
          )}

          {/* Why this matters — featured variant */}
          {news.whyThisMatters ? (
            <div className="mb-3 hidden sm:flex items-start gap-2">
              <span className="shrink-0 text-[10px] font-bold tracking-widest uppercase text-accent-400 mt-0.5">
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
      className="group flex flex-col rounded-lg bg-card border border-border hover:border-navy-200 dark:hover:border-slate-600 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 overflow-hidden"
    >
      {/* Cover: category gradient — 16:9 */}
      <div className={`relative w-full aspect-video overflow-hidden bg-gradient-to-br ${gradient}`} />

      {/* Body */}
      <div className="flex flex-col flex-1 p-4 sm:p-5">
        <span className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-600 bg-accent-500/10 px-2 py-0.5 rounded mb-2.5 w-fit">
          {categoryLabel}
        </span>

        <h3
          className="text-text text-[1.05rem] font-bold leading-snug mb-1.5 group-hover:text-accent-600 transition-colors duration-150 line-clamp-2 sm:line-clamp-3 font-playfair"
        >
          {news.title}
        </h3>

        {/* Market impact strip — default card */}
        {news.marketImpact && news.marketImpact.length > 0 && (
          <div className="mb-1.5">
            <MarketImpactStrip items={news.marketImpact} />
          </div>
        )}

        <p className="text-text-muted text-sm leading-relaxed line-clamp-2 flex-1">
          {news.whyThisMatters || excerpt || ""}
        </p>

        <div className="flex items-center gap-2 text-text-light text-[11px] tracking-wide mt-3 pt-3 border-t border-border/60">
          <time dateTime={news.publishedAt}>{formatDate(news.publishedAt)}</time>
          {news.wordCount && news.wordCount > 0 && (
            <>
              <span aria-hidden="true">&#183;</span>
              <span>{Math.ceil(news.wordCount / 230)} min read</span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
