import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Redis } from "@upstash/redis";
import { NewsCollection, NewsItem } from "@/lib/news-types";
import { SUPPRESSED_ARTICLE_IDS } from "@/lib/suppressed-articles";

interface Props {
  params: Promise<{ id: string }>;
}

async function getNewsItem(id: string): Promise<NewsItem | null> {
  // Return 404 immediately for suppressed articles
  if (SUPPRESSED_ARTICLE_IDS.has(id)) return null;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  try {
    const kv = new Redis({ url, token });
    const data = await kv.get<NewsCollection>("news");
    return data?.news.find((n) => n.id === id) ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const item = await getNewsItem(id);
  if (!item) return {};
  return {
    title: `${item.title} | Market Mountain`,
    description: item.whyThisMatters ?? item.story.split(".")[0] + ".",
    alternates: { canonical: `/news/${id}` },
    openGraph: {
      title: item.title,
      description: item.whyThisMatters ?? item.story.split(".")[0] + ".",
      type: "article",
      publishedTime: item.publishedAt,
      ...(item.imageUrl ? { images: [{ url: item.imageUrl, width: 1200, height: 630 }] } : {}),
    },
  };
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
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default async function NewsStoryPage({ params }: Props) {
  const { id } = await params;
  const item = await getNewsItem(id);
  if (!item) notFound();

  const gradient = categoryGradients[item.category] ?? categoryGradients.other;
  const categoryLabel = categoryLabels[item.category] ?? "Market News";

  // Unique sources for attribution
  const uniqueSources = item.sourcesUsed
    .filter((s, i, arr) => arr.findIndex((x) => x.source === s.source) === i)
    .slice(0, 6);

  // Split story into paragraphs
  const paragraphs = item.story
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <>
      {/* Hero */}
      <div className="bg-navy-900 text-white">
        {/* Cover: photo or gradient */}
        {item.imageUrl ? (
          <div className="relative h-48 sm:h-64 md:h-80 overflow-hidden">
            <Image
              src={item.imageUrl}
              alt={item.title}
              fill
              className="object-cover opacity-50"
              priority
              sizes="100vw"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-navy-900 via-navy-900/60 to-navy-900/20" />
          </div>
        ) : (
          <div className={`relative h-48 sm:h-64 md:h-80 overflow-hidden bg-gradient-to-br ${gradient}`}>
            <div className="absolute inset-0 bg-gradient-to-t from-navy-900 via-navy-900/60 to-navy-900/20" />
          </div>
        )}

        <div className="mx-auto max-w-[720px] px-4 sm:px-6 py-10 sm:py-14">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-[11px] text-white/35 mb-5" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-white/60 transition-colors">Home</Link>
            <span aria-hidden="true">/</span>
            <Link href="/news" className="hover:text-white/60 transition-colors">Market News</Link>
            <span aria-hidden="true">/</span>
            <span className="text-white/55 line-clamp-1">{item.title}</span>
          </nav>

          {/* Category tag */}
          <div className="mb-5">
            <span className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-300 bg-white/10 px-2 py-0.5 rounded">
              {categoryLabel}
            </span>
          </div>

          {/* Title */}
          <h1
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-[1.15] tracking-tight mb-6"
            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
          >
            {item.title}
          </h1>

          {/* Key Takeaways — 3-bullet summary */}
          {item.keyTakeaways && item.keyTakeaways.length > 0 && (
            <div className="mb-6">
              <p className="text-accent-300 text-[10px] font-bold tracking-widest uppercase mb-2">
                Key Takeaways
              </p>
              <ul className="space-y-1.5">
                {item.keyTakeaways.map((takeaway, i) => (
                  <li key={i} className="flex items-start gap-2 text-white/75 text-sm leading-relaxed">
                    <span className="mt-1.5 flex-shrink-0 w-1.5 h-1.5 rounded-full bg-accent-500" aria-hidden="true" />
                    {takeaway}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Why this matters — hero callout */}
          {item.whyThisMatters && (
            <div className="border-l-2 border-accent-500 pl-4 mb-6">
              <p className="text-accent-300 text-[10px] font-bold tracking-widest uppercase mb-1">
                Why it matters
              </p>
              <p className="text-white/75 text-sm leading-relaxed">{item.whyThisMatters}</p>
            </div>
          )}

          {/* Meta */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-white/40 text-[11px] tracking-widest uppercase">
            <span className="text-white/55 normal-case tracking-normal text-xs font-medium">
              Market Mountain
            </span>
            <span className="w-3 h-px bg-white/20" aria-hidden="true" />
            <time dateTime={item.publishedAt}>{formatDate(item.publishedAt)}</time>
            {item.relatedTickers && item.relatedTickers.length > 0 && (
              <>
                <span className="w-3 h-px bg-white/20" aria-hidden="true" />
                <span className="normal-case tracking-normal">
                  {item.relatedTickers.slice(0, 3).join(" · ")}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Accent divider */}
      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

      {/* Story body */}
      <div className="mx-auto max-w-[720px] px-4 sm:px-6 py-10 sm:py-14">
        <div className="lg:grid lg:grid-cols-3 lg:gap-12">
          {/* Main story column */}
          <article className="lg:col-span-2">
            <div className="prose prose-slate max-w-none">
              {paragraphs.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>

            {/* Tickers */}
            {item.relatedTickers && item.relatedTickers.length > 0 && (
              <div className="mt-8 flex flex-wrap gap-2">
                {item.relatedTickers.map((ticker) => (
                  <span
                    key={ticker}
                    className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded text-xs font-mono font-semibold"
                  >
                    {ticker}
                  </span>
                ))}
              </div>
            )}

            {/* Second-order implication */}
            {item.secondOrderImplication && (
              <div className="mt-8 p-5 rounded-lg bg-navy-50 border border-border">
                <p className="text-[10px] font-bold tracking-widest uppercase text-navy-600 mb-1.5">
                  Second-Order Implication
                </p>
                <p className="text-navy-900 text-sm leading-relaxed">
                  {item.secondOrderImplication}
                </p>
              </div>
            )}

            {/* What to watch next */}
            {item.whatToWatchNext && (
              <div className="mt-4 p-5 rounded-lg bg-accent-50 border border-accent-200">
                <p className="text-[10px] font-bold tracking-widest uppercase text-accent-700 mb-1.5">
                  What to Watch Next
                </p>
                <p className="text-navy-900 text-sm leading-relaxed">{item.whatToWatchNext}</p>
              </div>
            )}

            {/* Source attribution */}
            <div className="mt-8 pt-6 border-t border-border">
              <p className="text-xs font-semibold tracking-widest uppercase text-text-light mb-3">
                Data Sources
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {uniqueSources.map((src) =>
                  src.url ? (
                    <a
                      key={src.source}
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-accent-600 hover:text-accent-700 hover:underline transition-colors"
                    >
                      {src.source}
                    </a>
                  ) : (
                    <span key={src.source} className="text-sm text-text-muted">
                      {src.source}
                    </span>
                  )
                )}
              </div>
              {item.keyDataPoints && item.keyDataPoints.length > 0 && (
                <p className="text-xs text-text-light mt-2">
                  Market data:{" "}
                  {item.keyDataPoints
                    .map((d) => d.source)
                    .filter(Boolean)
                    .filter((s, i, a) => a.indexOf(s) === i)
                    .join(", ")}
                </p>
              )}
            </div>

            {/* Footer: back link */}
            <div className="mt-8 pt-6 border-t border-border flex items-center justify-between">
              <Link
                href="/news"
                className="inline-flex items-center gap-2 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M12 7H2M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Back to Market News
              </Link>
              <Link
                href="/briefing"
                className="text-sm font-medium text-text-muted hover:text-navy-900 transition-colors"
              >
                Today&apos;s Briefing
              </Link>
            </div>
          </article>

          {/* Key Data sidebar (desktop only) */}
          {item.keyDataPoints && item.keyDataPoints.length > 0 && (
            <aside className="hidden lg:block">
              <div className="sticky top-6">
                <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-4">
                  Key Data
                </p>
                <div className="bg-navy-900 rounded-xl overflow-hidden">
                  <div className="divide-y divide-white/10">
                    {item.keyDataPoints.map((dp, i) => (
                      <div key={i} className="px-4 py-3.5">
                        <p className="text-white/40 text-[9px] font-semibold tracking-wider uppercase mb-0.5">
                          {dp.label}
                        </p>
                        <div className="flex items-baseline gap-2">
                          <span className="text-white font-bold text-base">{dp.value}</span>
                          {dp.change && (
                            <span
                              className={`text-xs font-semibold ${
                                dp.change.startsWith("-") ? "text-red-400" : "text-accent-400"
                              }`}
                            >
                              {dp.change}
                            </span>
                          )}
                        </div>
                        {dp.source && (
                          <p className="text-white/25 text-[9px] mt-0.5">{dp.source}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>
    </>
  );
}
