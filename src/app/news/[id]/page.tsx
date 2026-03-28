import { notFound } from "next/navigation";
import type { Metadata } from "next";
import React from "react";
import Link from "next/link";
import Image from "next/image";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection, NewsItem, MarketImpactItem, ChartDataset } from "@/lib/news-types";
import { applyArticlePatches } from "@/lib/news-patches";
import { categoryLabels, categoryGradients, categoryAccentBorder, categoryAccentText } from "@/lib/category-config";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";
import { formatDate } from "@/lib/article-types";
import { SUPPRESSED_ARTICLE_IDS } from "@/lib/suppressed-articles";
import { BLOCKED_SOURCES, TIER_1_SOURCES } from "@/lib/news";
import { findRelatedStories } from "@/lib/related-stories";
import { NewsInlineChart, NewsKeyDataInline } from "@/components/NewsInlineChart";
import ReadingProgress from "@/components/ReadingProgress";
import ShareBar from "@/components/ShareBar";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://marketmountainfinance.com";

interface Props {
  params: Promise<{ id: string }>;
}

// React.cache deduplicates this fetch within a single request lifecycle,
// so generateMetadata and the page component share one KV round-trip.
const getNewsItemWithCollection = React.cache(async function getNewsItemWithCollection(id: string): Promise<{ item: NewsItem | null; allStories: NewsItem[] }> {
  // Return 404 immediately for suppressed articles
  if (SUPPRESSED_ARTICLE_IDS.has(id)) return { item: null, allStories: [] };

  const kv = getRedisClient();
  if (!kv) return { item: null, allStories: [] };

  try {
    const data = await kv.get<NewsCollection>("news");
    const allStories = (data?.news ?? [])
      .filter((n) => !SUPPRESSED_ARTICLE_IDS.has(n.id) && new Date(n.publishedAt).getTime() >= MARCH_13_CUTOFF_MS)
      .map(applyArticlePatches);
    const item = allStories.find((n) => n.id === id) ?? null;
    return { item, allStories };
  } catch {
    return { item: null, allStories: [] };
  }
});

async function getNewsItem(id: string): Promise<NewsItem | null> {
  const { item } = await getNewsItemWithCollection(id);
  return item;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const item = await getNewsItem(id);
  if (!item) return {};
  return {
    title: item.title,
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

// ---------------------------------------------------------------------------
// Market Impact Box component — displayed inline in article body
// ---------------------------------------------------------------------------

function MarketImpactBox({ items }: { items: MarketImpactItem[] }) {
  return (
    <div className="mt-8 p-5 rounded-lg bg-surface-2 border border-border">
      <p className="text-[10px] font-bold tracking-widest uppercase text-text-muted mb-3">
        Market Impact
      </p>
      <div className="flex flex-wrap gap-3">
        {items.map((item, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-semibold ${
              item.direction === "up"
                ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-700 dark:text-emerald-400"
                : item.direction === "down"
                ? "bg-red-500/10 border-red-500/25 text-red-700 dark:text-red-400"
                : "bg-surface-2 border-border text-text-muted"
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
  const { item, allStories } = await getNewsItemWithCollection(id);
  if (!item) notFound();

  const gradient = categoryGradients[item.category] ?? categoryGradients.other;
  const categoryLabel = categoryLabels[item.category] ?? "Market News";
  const relatedStories = findRelatedStories(item, allStories, 3);

  // Unique sources for attribution — exclude blocked/low-quality outlets
  const uniqueSources = item.sourcesUsed
    .filter((s, i, arr) => arr.findIndex((x) => x.source === s.source) === i)
    .filter((s) => {
      const lower = s.source.toLowerCase();
      return !BLOCKED_SOURCES.some((blocked) => lower.includes(blocked));
    })
    .slice(0, 6);

  // Split story into paragraphs, sanitizing hashtags (e.g., "#Stagflation" → "Stagflation")
  const paragraphs = item.story
    .split(/\n+/)
    .map((p) => p.trim().replace(/(?<!\w)#([A-Za-z]\w*)/g, "$1"))
    .filter(Boolean);

  // Category-specific accent for pull quotes and dividers
  const accentBorder = categoryAccentBorder[item.category] ?? categoryAccentBorder.other;
  const accentText = categoryAccentText[item.category] ?? categoryAccentText.other;

  // Auto-extract a pull quote from the story for visual variety.
  // Pick a strong declarative sentence from the middle third of the article.
  // Only show if article has no inline image (avoids visual overload).
  const textParagraphs = paragraphs.filter((p) => !p.startsWith("## ") && !p.startsWith("> "));
  let pullQuote: string | null = null;
  let pullQuoteAfterParagraph = -1;
  if (!item.inlineImageUrl && textParagraphs.length >= 5) {
    const midStart = Math.floor(textParagraphs.length * 0.3);
    const midEnd = Math.floor(textParagraphs.length * 0.7);
    const candidates = textParagraphs.slice(midStart, midEnd);
    for (const para of candidates) {
      // Find a strong sentence (contains a number or key phrase, 15-40 words)
      const sentences = para.split(/(?<=[.!?])\s+/);
      const strong = sentences.find((s) => {
        const wordCount = s.split(/\s+/).length;
        return wordCount >= 15 && wordCount <= 40 && /\d/.test(s);
      });
      if (strong) {
        pullQuote = strong;
        // Place it after the 4th text paragraph
        pullQuoteAfterParagraph = paragraphs.indexOf(textParagraphs[3]);
        break;
      }
    }
  }

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

  const storyUrl = `${SITE_URL}/news/${item.id}`;

  const newsJsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: item.title,
      url: storyUrl,
      datePublished: item.publishedAt,
      author: { "@type": "Organization", name: "Market Mountain", url: SITE_URL },
      publisher: {
        "@type": "Organization",
        name: "Market Mountain",
        url: SITE_URL,
        logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.svg` },
      },
      ...(item.imageUrl ? { image: { "@type": "ImageObject", url: item.imageUrl } } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Market News", item: `${SITE_URL}/news` },
        { "@type": "ListItem", position: 3, name: item.title },
      ],
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(newsJsonLd) }}
      />
      <ReadingProgress />
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

          {/* Meta + Share */}
          <div className="flex flex-wrap items-center justify-between gap-y-3">
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
            <ShareBar url={storyUrl} title={item.title} />
          </div>
        </div>
      </div>

      {/* Accent divider */}
      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

      {/* Story body */}
      <div className="bg-card">
      <div className="mx-auto max-w-[720px] px-4 sm:px-6 py-10 sm:py-14">
        <article>
          <div className="prose prose-slate max-w-none">
            {paragraphs.map((para, i) => {
              // Track which text paragraph index this is (skip headings and blockquotes)
              const isHeading = para.startsWith("## ");
              const isBlockquote = para.startsWith("> ");
              const isFirstTextPara = !isHeading && !isBlockquote &&
                paragraphs.slice(0, i).every((p) => p.startsWith("## ") || p.startsWith("> "));

              return (
              <React.Fragment key={i}>
                {/* Render ## headings as styled <h2> section dividers */}
                {isHeading ? (
                  <h2 className="text-lg font-bold text-text mt-8 mb-3 font-playfair tracking-tight">
                    {para.slice(3)}
                  </h2>
                ) : isBlockquote ? (
                  /* Render > lines as category-accented blockquotes */
                  <blockquote className={`not-prose my-6 pl-4 border-l-3 ${accentBorder}`}>
                    <p className={`text-sm italic leading-relaxed ${accentText}`}>
                      {para.slice(2)}
                    </p>
                  </blockquote>
                ) : isFirstTextPara ? (
                  /* Lead paragraph — slightly larger for editorial weight */
                  <p className="text-base leading-relaxed text-text font-medium">{para}</p>
                ) : (
                  <p>{para}</p>
                )}

                {/* Pull quote — visual break for longer articles without inline images */}
                {pullQuote && pullQuoteAfterParagraph === i && (
                  <div className={`not-prose my-8 py-4 pl-5 border-l-3 ${accentBorder} bg-surface-2 rounded-r-lg`}>
                    <p className="text-base font-medium text-text leading-relaxed italic">
                      &ldquo;{pullQuote}&rdquo;
                    </p>
                  </div>
                )}
                {/* Inject charts assigned to this paragraph index */}
                {chartsByParagraph.has(i) && (
                  <div className="not-prose">
                    {chartsByParagraph.get(i)!.map((chart, ci) => (
                      <NewsInlineChart key={ci} chart={chart} />
                    ))}
                  </div>
                )}
                {/* Inline images disabled — generic Unsplash stock photos
                   added no editorial value and the same image was reused
                   across multiple unrelated articles. */}
              </React.Fragment>
              );
            })}
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

          {/* Verified Claims — kept in data for editorial QA, not shown to readers */}

          {/* Tickers */}
          {item.relatedTickers && item.relatedTickers.length > 0 && (
            <div className="mt-8 flex flex-wrap gap-2">
              {item.relatedTickers.map((ticker) => (
                <span
                  key={ticker}
                  className="px-2.5 py-1 bg-surface-2 text-text rounded text-xs font-mono font-semibold"
                >
                  {ticker}
                </span>
              ))}
            </div>
          )}

          {/* Second-order implication */}
          {item.secondOrderImplication && (
            <div className="mt-8 p-5 rounded-lg bg-surface-2 border border-border">
              <p className="text-[10px] font-bold tracking-widest uppercase text-text-muted mb-1.5">
                Second-Order Implication
              </p>
              <p className="text-text text-sm leading-relaxed">
                {item.secondOrderImplication}
              </p>
            </div>
          )}

          {/* What to watch next */}
          {item.whatToWatchNext && (
            <div className="mt-4 p-5 rounded-lg bg-accent-500/10 border border-accent-500/25">
              <p className="text-[10px] font-bold tracking-widest uppercase text-accent-700 mb-1.5">
                What to Watch Next
              </p>
              <p className="text-text text-sm leading-relaxed">{item.whatToWatchNext}</p>
            </div>
          )}

          {/* Source attribution */}
          <div className="mt-8 pt-6 border-t border-border">
            <p className="text-xs font-semibold tracking-widest uppercase text-text-light mb-3">
              Data Sources
            </p>
            <div className="flex flex-wrap gap-2">
              {uniqueSources.map((src) => {
                const isTier1 = TIER_1_SOURCES.some((t) => src.source.toLowerCase().includes(t));
                const badge = isTier1 ? (
                  <svg className="w-3 h-3 text-accent-500 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-label="Verified source">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                ) : null;
                return src.url ? (
                  <a
                    key={src.source}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors break-words min-w-0 max-w-full ${
                      isTier1
                        ? "bg-accent-500/10 text-accent-600 hover:bg-accent-500/15"
                        : "bg-surface-2 text-accent-600 hover:bg-border"
                    }`}
                  >
                    {badge}
                    {src.source}
                  </a>
                ) : (
                  <span
                    key={src.source}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-surface-2 text-xs font-medium text-text-muted break-words min-w-0 max-w-full"
                  >
                    {badge}
                    {src.source}
                  </span>
                );
              })}
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
              className="text-sm font-medium text-text-muted hover:text-text transition-colors"
            >
              Today&apos;s Briefing
            </Link>
          </div>
        </article>
      </div>
      </div>

      {/* Related Coverage */}
      {relatedStories.length > 0 && (
        <section className="bg-surface border-t border-border">
          <div className="mx-auto max-w-[720px] px-4 sm:px-6 py-10">
            <h2 className="text-sm font-bold tracking-widest uppercase text-text-light mb-6">
              Related Coverage
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {relatedStories.map((story) => (
                <Link
                  key={story.id}
                  href={`/news/${story.id}`}
                  className="group block p-4 rounded-lg border border-border hover:border-accent-300 hover:shadow-sm bg-card transition-all duration-200"
                >
                  <span className="text-[10px] font-semibold tracking-wider uppercase text-accent-600 mb-1.5 block">
                    {categoryLabels[story.category] ?? "Market News"}
                  </span>
                  <h3 className="text-sm font-semibold text-text leading-snug line-clamp-3 group-hover:text-accent-700 transition-colors">
                    {story.title}
                  </h3>
                  <time className="text-[11px] text-text-light mt-2 block">
                    {formatDate(story.publishedAt)}
                  </time>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
