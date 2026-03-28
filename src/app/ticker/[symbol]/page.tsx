import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllArticles } from "@/lib/articles";
import { getRedisClient } from "@/lib/redis";
import type { NewsCollection, NewsItem } from "@/lib/news-types";
import { fetchFmpQuote } from "@/lib/market-data";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";
import { applyArticlePatches } from "@/lib/news-patches";
import { formatDate } from "@/lib/article-types";

export const revalidate = 300; // 5 min ISR

interface Props {
  params: Promise<{ symbol: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { symbol } = await params;
  const ticker = symbol.toUpperCase();
  return {
    title: `${ticker} Coverage`,
    description: `All Market Mountain research and news coverage for ${ticker}.`,
  };
}

export default async function TickerPage({ params }: Props) {
  const { symbol } = await params;
  const ticker = symbol.toUpperCase();

  // Find articles mentioning this ticker
  const articles = getAllArticles().filter(
    (a) => a.ticker?.toUpperCase() === ticker || a.title.toUpperCase().includes(ticker)
  );

  // Find news stories mentioning this ticker
  let newsStories: NewsItem[] = [];
  const kv = getRedisClient();
  if (kv) {
    try {
      const data = await kv.get<NewsCollection>("news");
      newsStories = (data?.news ?? [])
        .filter((n) => new Date(n.publishedAt).getTime() >= MARCH_13_CUTOFF_MS)
        .map(applyArticlePatches)
        .filter(
          (n) =>
            n.relatedTickers?.some((t) => t.toUpperCase() === ticker) ||
            n.title.toUpperCase().includes(ticker)
        )
        .slice(0, 10);
    } catch {
      // Non-fatal
    }
  }

  if (articles.length === 0 && newsStories.length === 0) {
    notFound();
  }

  // Fetch live quote
  const currentPrice = await fetchFmpQuote(ticker);

  // Find research pick if one exists
  const researchPick = articles.find((a) => a.priceTarget && a.priceAtPublish);

  return (
    <div className="min-h-screen bg-surface">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-12 sm:py-16">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <p className="text-accent-400 text-xs font-semibold tracking-[0.2em] uppercase mb-2">
            TICKER COVERAGE
          </p>
          <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            {ticker}
          </h1>

          {/* Live price */}
          {currentPrice && (
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold">${currentPrice.toFixed(2)}</span>
              {researchPick?.priceAtPublish && (
                <span
                  className={`text-sm font-semibold ${
                    currentPrice >= researchPick.priceAtPublish
                      ? "text-accent-400"
                      : "text-red-400"
                  }`}
                >
                  {currentPrice >= researchPick.priceAtPublish ? "+" : ""}
                  {(
                    ((currentPrice - researchPick.priceAtPublish) /
                      researchPick.priceAtPublish) *
                    100
                  ).toFixed(1)}
                  % since coverage
                </span>
              )}
            </div>
          )}

          {/* Research summary */}
          {researchPick && (
            <div className="mt-4 flex items-center gap-3 text-sm text-white/70">
              {researchPick.rating && (
                <span className="px-2 py-0.5 rounded bg-accent-500/20 text-accent-300 font-semibold uppercase text-xs">
                  {researchPick.rating}
                </span>
              )}
              {researchPick.priceTarget && (
                <span>Target: ${researchPick.priceTarget}</span>
              )}
              {researchPick.priceAtPublish && (
                <span>Entry: ${researchPick.priceAtPublish}</span>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10 sm:py-14">
        {/* Research articles */}
        {articles.length > 0 && (
          <section className="mb-10">
            <h2 className="text-lg font-serif font-bold text-text mb-4">
              Research Articles
            </h2>
            <div className="space-y-3">
              {articles.map((article) => (
                <Link
                  key={article.slug}
                  href={`/post/${article.slug}`}
                  className="block bg-card rounded-lg border border-border p-5 hover:border-accent-300 hover:shadow-sm transition-all"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    {article.rating && (
                      <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-accent-100 text-accent-700">
                        {article.rating}
                      </span>
                    )}
                    {article.priceTarget && (
                      <span className="text-[11px] font-semibold text-accent-600">
                        PT: ${article.priceTarget}
                      </span>
                    )}
                    <span className="text-[11px] text-text-light ml-auto">
                      {formatDate(article.date)}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-text">{article.title}</h3>
                  <p className="text-sm text-text-muted mt-1 line-clamp-2">{article.excerpt}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* News coverage */}
        {newsStories.length > 0 && (
          <section>
            <h2 className="text-lg font-serif font-bold text-text mb-4">
              News Coverage
            </h2>
            <div className="space-y-3">
              {newsStories.map((story) => (
                <Link
                  key={story.id}
                  href={`/news/${story.id}`}
                  className="block bg-card rounded-lg border border-border p-4 hover:border-accent-300 hover:shadow-sm transition-all"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-navy-100 text-navy-600">
                      {story.category}
                    </span>
                    <span className="text-[11px] text-text-light ml-auto">
                      {formatDate(story.publishedAt)}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-text">{story.title}</h3>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
