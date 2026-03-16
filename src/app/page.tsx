import { getAllArticles } from "@/lib/articles";
import ArticleCard from "@/components/ArticleCard";
import Link from "next/link";
import NewsSection from "@/components/NewsSection";
import MacroBoard from "@/components/MacroBoard";
import MarketStrip from "@/components/MarketStrip";
import { MarketDataProvider } from "@/contexts/MarketDataContext";

export default function HomePage() {
  const articles = getAllArticles();
  const featured = articles[0];
  const rest = articles.slice(1, 4);

  return (
    <>
      {/* Hero */}
      <section className="bg-navy-900 text-white border-b border-white/10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="flex flex-col sm:flex-row sm:items-end gap-6 sm:gap-12">
            <div className="flex-1">
              <p className="text-[10px] font-bold tracking-widest uppercase text-accent-400 mb-2">
                {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold font-playfair leading-tight text-white mb-2">
                Independent market research and macro commentary
              </h1>
              <p className="text-white/50 text-sm leading-relaxed max-w-lg">
                Data-driven equity analysis and curated daily briefings by Trevor Carnovsky.
              </p>
            </div>
            <div className="flex gap-3 shrink-0">
              <Link
                href="/briefing"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-accent-500 hover:bg-accent-400 text-navy-950 font-semibold text-sm transition-colors"
              >
                Today&apos;s Briefing
              </Link>
              <Link
                href="/articles"
                className="inline-flex items-center px-5 py-2.5 rounded-full border border-white/20 hover:bg-white/10 text-white font-medium text-sm transition-colors"
              >
                Latest Analysis
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Shared market data — single fetch/poll for strip + dashboard (prevents value drift) */}
      <MarketDataProvider>
        {/* Market Snapshot Strip — live price ticker (S&P, 10Y, Oil, BTC, VIX, DXY) */}
        <MarketStrip />

        {/* Macro Board — live indicators + regime classification */}
        <MacroBoard />
      </MarketDataProvider>

      {/* Morning Brief — prominently above market data */}
      <section className="bg-navy-800 border-b border-white/10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-accent-500/20 flex items-center justify-center shrink-0">
              <span className="w-2 h-2 rounded-full bg-accent-400 animate-pulse" />
            </div>
            <div>
              <span className="text-[10px] font-bold tracking-widest uppercase text-accent-400 block mb-0.5">
                Today&apos;s Briefing
              </span>
              <p className="text-white/60 text-xs">Lead story, key data, and what to watch next</p>
            </div>
          </div>
          <Link
            href="/briefing"
            className="shrink-0 text-xs font-semibold text-accent-400 hover:text-accent-300 transition-colors whitespace-nowrap"
          >
            Read now →
          </Link>
        </div>
      </section>

      {/* Market News */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-14 sm:py-20">
        <div className="flex items-center justify-between mb-8 sm:mb-10">
          <div className="flex items-center gap-3">
            <span className="block w-[3px] h-5 rounded-full bg-accent-500 shrink-0" aria-hidden="true" />
            <h2 className="text-xl sm:text-2xl font-bold text-navy-900 font-playfair tracking-tight">
              Market News
            </h2>
          </div>
          <Link
            href="/news"
            className="text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors hidden sm:inline-flex items-center gap-1"
          >
            View all
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>

        <NewsSection
          limit={3}
          noFeatured
          showCategories={false}
          showSort={false}
        />

        {/* Mobile "view all" link */}
        <div className="mt-8 text-center sm:hidden">
          <Link
            href="/news"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
          >
            View all news
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>
      </section>

      {/* Latest Analysis — Trevor's original research posts */}
      <section className="bg-navy-50 border-t border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-14 sm:py-20">
        <div className="flex items-center justify-between mb-8 sm:mb-10">
          <div className="flex items-center gap-3">
            <span className="block w-[3px] h-5 rounded-full bg-accent-500 shrink-0" aria-hidden="true" />
            <h2 className="text-xl sm:text-2xl font-bold text-navy-900 font-playfair tracking-tight">
              Latest Analysis
            </h2>
          </div>
          <Link
            href="/articles"
            className="text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors hidden sm:inline-flex items-center gap-1"
          >
            View all
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>

        {/* Featured card */}
        {featured && (
          <div className="mb-6 sm:mb-8">
            <ArticleCard article={featured} featured />
          </div>
        )}

        {/* Article grid */}
        {rest.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
            {rest.map((article) => (
              <ArticleCard key={article.slug} article={article} />
            ))}
          </div>
        )}

        {articles.length === 0 && (
          <p className="text-text-muted text-center py-16">
            No articles yet — check back soon.
          </p>
        )}

        {/* Mobile "view all" link */}
        <div className="mt-8 text-center sm:hidden">
          <Link
            href="/articles"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
          >
            View all articles
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>
        </div>{/* /max-w-7xl */}
      </section>

      {/* About strip */}
      <section className="bg-white border-t border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16 flex flex-col md:flex-row items-center gap-8 md:gap-12">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold tracking-widest uppercase text-accent-600 mb-2">
              About the Author
            </p>
            <h2
              className="text-2xl font-bold text-navy-900 mb-3 font-playfair"
            >
              Trevor Carnovsky
            </h2>
            <p className="text-text-muted text-sm sm:text-base leading-relaxed max-w-2xl">
              I&apos;m a student at Central Michigan University with a strong
              interest in financial markets and long-term value creation. Through
              Market Mountain, I share thoughtful perspectives on market
              conditions, macroeconomic developments, and in-depth analysis of
              individual equities. My work emphasizes data-driven analysis,
              fundamental research, and disciplined investment frameworks.
            </p>
          </div>
          <Link
            href="/about"
            className="shrink-0 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-navy-900 hover:bg-navy-800 text-white font-medium text-sm transition-colors"
          >
            Learn more
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>
      </section>
    </>
  );
}
