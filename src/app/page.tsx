import { getAllArticles } from "@/lib/articles";
import ArticleCard from "@/components/ArticleCard";
import Logo from "@/components/Logo";
import Link from "next/link";
import NewsSection from "@/components/NewsSection";
import MacroBoard from "@/components/MacroBoard";
import SignalBar from "@/components/SignalBar";

export default function HomePage() {
  const articles = getAllArticles();
  const featured = articles[0];
  const rest = articles.slice(1, 7);

  return (
    <>
      {/* Hero */}
      <section className="bg-navy-900 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 sm:py-28 flex flex-col items-center text-center">
          <div className="mb-8">
            <Logo variant="light" size="lg" />
          </div>
          <p className="text-white/60 text-base sm:text-lg max-w-xl leading-relaxed">
            Independent equity research, macroeconomic analysis, and disciplined
            investment frameworks.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <Link
              href="/articles"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-accent-500 hover:bg-accent-400 text-navy-950 font-semibold text-sm transition-colors"
            >
              Browse All Articles
            </Link>
            <Link
              href="/about"
              className="inline-flex items-center justify-center px-6 py-3 rounded-full border border-white/20 hover:bg-white/10 text-white font-medium text-sm transition-colors"
            >
              About the Author
            </Link>
          </div>
        </div>
      </section>

      {/* Macro Board — live indicators + regime classification */}
      <MacroBoard />

      {/* Market Signal Bar — directional signals */}
      <SignalBar />

      {/* Accent divider */}
      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

      {/* Morning Brief — link to today's curated briefing */}
      <section className="bg-navy-50 border-b border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex-shrink-0 w-8 h-8 rounded-full bg-navy-900 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="5.5" stroke="#22C55E" strokeWidth="1.5" />
                <path d="M7 4v3l2 2" stroke="#22C55E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <p className="text-[10px] font-bold tracking-widest uppercase text-accent-600 mb-0.5">
                Morning Brief
              </p>
              <p className="text-navy-900 text-sm font-medium">
                Today&apos;s curated summary — lead story, key data, and what to watch
              </p>
            </div>
          </div>
          <Link
            href="/briefing"
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-navy-900 hover:bg-navy-800 text-white font-medium text-xs transition-colors"
          >
            Read Briefing
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2 6h8M6 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
      </section>

      {/* Market News */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-14 sm:py-20">
        <div className="flex items-baseline justify-between mb-8 sm:mb-10">
          <h2
            className="text-2xl sm:text-3xl font-bold text-navy-900"
            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
          >
            Market News
          </h2>
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
          limit={6}
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
        <div className="flex items-baseline justify-between mb-8 sm:mb-10">
          <h2
            className="text-2xl sm:text-3xl font-bold text-navy-900"
            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
          >
            Latest Analysis
          </h2>
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
              className="text-2xl font-bold text-navy-900 mb-3"
              style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
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
