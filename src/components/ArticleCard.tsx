import Link from "next/link";
import Image from "next/image";
import { ArticleMeta, formatDate } from "@/lib/articles";

interface ArticleCardProps {
  article: ArticleMeta;
  featured?: boolean;
}

export default function ArticleCard({ article, featured = false }: ArticleCardProps) {
  const href = `/post/${article.slug}`;
  const tag = article.tags?.[0];

  if (featured) {
    return (
      <Link
        href={href}
        className="group block relative overflow-hidden rounded-xl bg-navy-900 shadow-lg hover:shadow-2xl transition-all duration-300"
        style={{ minHeight: 360 }}
      >
        {article.coverImage ? (
          <Image
            src={article.coverImage}
            alt={article.title}
            fill
            className="object-cover opacity-40 group-hover:opacity-50 group-hover:scale-[1.03] transition-all duration-500"
            style={{ objectPosition: article.coverImagePosition ?? "center 20%" }}
            sizes="(max-width: 768px) 100vw, 66vw"
            priority
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-navy-800 via-navy-900 to-navy-950" />
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-navy-950 via-navy-950/60 to-transparent" />

        <div className="absolute inset-0 flex flex-col justify-end p-7 sm:p-10">
          {tag && (
            <span className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-300 bg-white/10 px-2 py-0.5 rounded mb-4 w-fit">
              {tag}
            </span>
          )}

          <h2
            className="text-white text-2xl sm:text-[1.75rem] font-bold leading-tight mb-3 group-hover:text-accent-300 transition-colors duration-200 font-playfair"
          >
            {article.title}
          </h2>

          <p className="text-white/55 text-sm leading-relaxed mb-5 line-clamp-2 hidden sm:block">
            {article.excerpt}
          </p>

          <div className="flex items-center gap-3 text-white/40 text-[11px] tracking-wide">
            <time dateTime={article.date}>{formatDate(article.date)}</time>
            <span className="text-white/30" aria-hidden="true">·</span>
            <span>{article.readTime}</span>
            <span className="ml-auto flex items-center gap-1.5 text-accent-400 text-xs font-semibold group-hover:gap-2.5 transition-all duration-200">
              Read article
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
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
      className="group flex flex-row sm:flex-col rounded-lg bg-card border border-border hover:border-navy-200 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 overflow-hidden"
    >
      {/* Image — square thumbnail on mobile, 16:9 on desktop */}
      {article.coverImage ? (
        <div className="relative w-28 h-28 flex-shrink-0 sm:w-full sm:h-auto sm:aspect-video overflow-hidden">
          <Image
            src={article.coverImage}
            alt={article.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            style={article.coverImagePosition ? { objectPosition: article.coverImagePosition } : undefined}
            sizes="(max-width: 640px) 112px, (max-width: 1024px) 50vw, 33vw"
          />
        </div>
      ) : (
        <div className="w-[3px] sm:w-full sm:h-[3px] flex-shrink-0 bg-gradient-to-b sm:bg-gradient-to-r from-accent-700 via-accent-500 to-accent-400" />
      )}

      <div className="flex flex-col flex-1 p-4 sm:p-6">
        {tag && (
          <span className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-700 bg-accent-100 px-2 py-0.5 rounded mb-2.5 w-fit">
            {tag}
          </span>
        )}

        <h3
          className="text-navy-900 text-[1.05rem] font-bold leading-snug mb-2 group-hover:text-navy-600 transition-colors duration-150 line-clamp-2 sm:line-clamp-3 font-playfair"
        >
          {article.title}
        </h3>

        <p className="text-text-muted text-sm leading-relaxed line-clamp-1 sm:line-clamp-2 flex-1">
          {article.excerpt}
        </p>

        <div className="flex items-center gap-2 text-text-light text-[11px] tracking-wide mt-3 sm:mt-4 sm:pt-4 sm:border-t sm:border-border/60">
          <time dateTime={article.date}>{formatDate(article.date)}</time>
          <span className="text-text-light" aria-hidden="true">·</span>
          <span>{article.readTime}</span>
        </div>
      </div>
    </Link>
  );
}
