import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Redis } from "@upstash/redis";
import { NewsCollection, NewsItem } from "@/lib/news-types";

interface Props {
  params: Promise<{ id: string }>;
}

async function getNewsItem(id: string): Promise<NewsItem | null> {
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
    description: item.story.split(".")[0] + ".",
    openGraph: {
      title: item.title,
      type: "article",
      publishedTime: item.publishedAt,
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

  const sourceNames = item.sourcesUsed
    .map((s) => s.source)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .join(", ");

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

        <div className="mx-auto max-w-[680px] px-4 sm:px-6 py-10 sm:py-14">
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
      <article className="mx-auto max-w-[680px] px-4 sm:px-6 py-10 sm:py-14">
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
                className="px-2.5 py-1 bg-slate-200 text-slate-700 rounded text-xs font-mono font-semibold"
              >
                {ticker}
              </span>
            ))}
          </div>
        )}

        {/* Source attribution */}
        <div className="mt-8 pt-6 border-t border-border">
          <p className="text-sm text-text-muted">
            <span className="font-medium text-navy-900">Based on analysis of </span>
            {sourceNames}
          </p>
        </div>

        {/* Footer: back link */}
        <div className="mt-8 pt-6 border-t border-border flex items-center justify-end">
          <Link
            href="/news"
            className="inline-flex items-center gap-2 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M12 7H2M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back to Market News
          </Link>
        </div>
      </article>
    </>
  );
}
