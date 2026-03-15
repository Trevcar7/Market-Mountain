import { notFound } from "next/navigation";
import type { Metadata } from "next";
import React from "react";
import Link from "next/link";
import Image from "next/image";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection, NewsItem, MarketImpactItem, ChartDataset } from "@/lib/news-types";
import { categoryLabels, categoryGradients } from "@/lib/category-config";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";
import { SUPPRESSED_ARTICLE_IDS } from "@/lib/suppressed-articles";
import { BLOCKED_SOURCES } from "@/lib/news";
import { NewsInlineChart, NewsKeyDataInline } from "@/components/NewsInlineChart";

interface Props {
  params: Promise<{ id: string }>;
}

async function getNewsItem(id: string): Promise<NewsItem | null> {
  // Return 404 immediately for suppressed articles
  if (SUPPRESSED_ARTICLE_IDS.has(id)) return null;

  const kv = getRedisClient();
  if (!kv) return null;

  try {
    const data = await kv.get<NewsCollection>("news");
    const item = data?.news.find((n) => n.id === id) ?? null;
    // Block direct URL access to March 12 articles
    if (item && new Date(item.publishedAt).getTime() < MARCH_13_CUTOFF_MS) return null;
    return item;
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

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Market Impact Box component — displayed inline in article body
// ---------------------------------------------------------------------------

function MarketImpactBox({ items }: { items: MarketImpactItem[] }) {
  return (
    <div className="mt-8 p-5 rounded-lg bg-navy-50 border border-border">
      <p className="text-[10px] font-bold tracking-widest uppercase text-navy-600 mb-3">
        Market Impact
      </p>
      <div className="flex flex-wrap gap-3">
        {items.map((item, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-semibold ${
              item.direction === "up"
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : item.direction === "down"
                ? "bg-red-50 border-red-200 text-red-700"
                : "bg-slate-50 border-slate-200 text-slate-600"
            }`}
          >
            <span className="font-bold tabular-nums tracking-wide">{item.asset}</span>
            <span
              className={`flex items-center gap-0.5 text-xs tabular-nums ${
                item.direction === "up"
                  ? "text-emerald-600"
                  : item.direction === "down"
                  ? "text-red-600"
                  : "text-slate-400"
              }`}
            >
              {item.direction === "up" ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M5 8V2M2 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : item.direction === "down" ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M5 2v6M2 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <span>—</span>
              )}
              {item.change}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function NewsStoryPage({ params }: Props) {
  const { id } = await params;
  const item = await getNewsItem(id);
  if (!item) notFound();

  const gradient = categoryGradients[item.category] ?? categoryGradients.other;
  const categoryLabel = categoryLabels[item.category] ?? "Market News";

  // Unique sources for attribution — exclude blocked/low-quality outlets
  const uniqueSources = item.sourcesUsed
    .filter((s, i, arr) => arr.findIndex((x) => x.source === s.source) === i)
    .filter((s) => {
      const lower = s.source.toLowerCase();
      return !BLOCKED_SOURCES.some((blocked) => lower.includes(blocked));
    })
    .slice(0, 6);

  // Split story into paragraphs
  const paragraphs = item.story
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Normalize chartData to array (backward-compatible: handles both legacy single-object and new array)
  const charts: ChartDataset[] = !item.chartData ? [] :
    Array.isArray(item.chartData) ? item.chartData : [item.chartData as unknown as ChartDataset];

  // Build per-paragraph chart map using insertAfterParagraph when set.
  // Fallback positions: chart[0] → after P1, chart[1] → after P3, rest → after story body.
  const FALLBACK_POSITIONS = [1, 3];
  const chartsByParagraph = new Map<number, ChartDataset[]>();
  const overflowCharts: ChartDataset[] = [];
  charts.forEach((chart, i) => {
    if (chart.insertAfterParagraph !== undefined) {
      const arr = chartsByParagraph.get(chart.insertAfterParagraph) ?? [];
      arr.push(chart);
      chartsByParagraph.set(chart.insertAfterParagraph, arr);
    } else {
      const pos = FALLBACK_POSITIONS[i];
      if (pos !== undefined) {
        const arr = chartsByParagraph.get(pos) ?? [];
        arr.push(chart);
        chartsByParagraph.set(pos, arr);
      } else {
        overflowCharts.push(chart);
      }
    }
  });

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
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-[1.15] tracking-tight mb-6 font-playfair"
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
        <article>
          <div className="prose prose-slate max-w-none">
            {paragraphs.map((para, i) => (
              <React.Fragment key={i}>
                <p>{para}</p>
                {/* Inject charts assigned to this paragraph index */}
                {chartsByParagraph.has(i) && (
                  <div className="not-prose">
                    {chartsByParagraph.get(i)!.map((chart, ci) => (
                      <NewsInlineChart key={ci} chart={chart} />
                    ))}
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>

          {/* Market Impact Box — shows asset-level impact when present */}
          {item.marketImpact && item.marketImpact.length > 0 && (
            <MarketImpactBox items={item.marketImpact} />
          )}

          {/* Overflow charts (no paragraph assignment, beyond fallback range) */}
          {overflowCharts.map((chart, i) => (
            <NewsInlineChart key={i} chart={chart} />
          ))}

          {/* Inline key data — replaces the desktop-only sidebar */}
          {item.keyDataPoints && item.keyDataPoints.length > 0 && (
            <NewsKeyDataInline dataPoints={item.keyDataPoints} />
          )}

          {/* Verified Claims — editorial transparency */}
          {item.verifiedClaims && item.verifiedClaims.length > 0 && (
            <div className="mt-8 p-5 rounded-lg bg-slate-50 border border-slate-200">
              <p className="text-[10px] font-bold tracking-widest uppercase text-slate-500 mb-3">
                Verified Claims
              </p>
              <ul className="space-y-1.5">
                {item.verifiedClaims.map((claim, i) => (
                  <li key={i} className="flex items-start gap-2 text-slate-700 text-sm leading-relaxed">
                    <svg className="mt-1 flex-shrink-0 w-3.5 h-3.5 text-accent-500" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M11.5 3.5L5.5 10.5L2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {claim}
                  </li>
                ))}
              </ul>
            </div>
          )}

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
      </div>
    </>
  );
}
