import type { Metadata } from "next";
import { getRedisClient } from "@/lib/redis";
import Link from "next/link";
import { DailyBriefing } from "@/lib/news-types";
import { categoryLabelsShort as categoryLabels, categoryColors } from "@/lib/category-config";

export const metadata: Metadata = {
  title: "Daily Markets Briefing | Market Mountain",
  description:
    "Today's curated financial markets briefing — lead story, top developments, key data, and what to watch next.",
  alternates: { canonical: "/briefing" },
  openGraph: {
    title: "Daily Markets Briefing | Market Mountain",
    description:
      "Today's curated financial markets briefing — lead story, top developments, key data, and what to watch next.",
    type: "website",
  },
};

// Revalidate every 5 minutes so the briefing stays fresh without hammering generation
export const revalidate = 300;

async function getBriefing(): Promise<DailyBriefing | null> {
  const kv = getRedisClient();
  if (!kv) return null;

  const date = new Date().toISOString().split("T")[0];
  const key = `briefing-${date}`;

  // 1. Try to return cached briefing from KV
  try {
    const briefing = await kv.get<DailyBriefing>(key);
    if (briefing) return briefing;
  } catch {
    // Fall through to lazy generation
  }

  // 2. No cached briefing for today — trigger lazy generation via the API
  // endpoint, which will generate from today's stories and save to KV.
  // This ensures the first visitor to /briefing each day triggers generation
  // automatically, even if no cron or pipeline produced one yet.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://marketmountainfinance.com";
  try {
    const res = await fetch(`${siteUrl}/api/briefing`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error) return data as DailyBriefing;
    }
  } catch {
    // Generation failed — show empty state
  }

  return null;
}

function formatLongDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatUpdateTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
}

export default async function BriefingPage() {
  const briefing = await getBriefing();

  return (
    <main className="min-h-screen bg-surface">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-14 sm:py-20">
        <div className="container mx-auto px-4 sm:px-6 max-w-4xl">
          <p className="text-xs font-semibold tracking-widest uppercase text-accent-400 mb-3">
            Daily Markets Briefing
          </p>
          <h1
            className="font-bold text-4xl sm:text-5xl leading-tight mb-4 font-playfair"
          >
            {briefing ? formatLongDate(briefing.date) : "Today's Briefing"}
          </h1>
          <p className="text-white/55 text-sm">
            {briefing
              ? `Today's market briefing · Updated ${formatUpdateTime(briefing.generatedAt)}`
              : "Curated editorial summary of the day's key market developments"}
          </p>
        </div>
      </section>

      {/* Accent divider */}
      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

      {!briefing ? (
        <NoBriefingState />
      ) : (
        <div className="container mx-auto px-4 sm:px-6 max-w-4xl py-12 sm:py-16 space-y-12">
          {/* Lead Story */}
          <section>
            <div className="flex items-center gap-3 mb-5">
              <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-accent-600 bg-accent-100 px-2.5 py-1 rounded">
                Lead Story
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <Link
              href={`/news/${briefing.leadStory.id}`}
              className="group block bg-navy-900 rounded-xl overflow-hidden hover:shadow-2xl transition-shadow duration-300"
            >
              <div className="p-7 sm:p-10">
                <h2
                  className="text-2xl sm:text-[1.9rem] font-bold text-white leading-tight mb-4 group-hover:text-accent-300 transition-colors duration-200 font-playfair"
                >
                  {briefing.leadStory.title}
                </h2>

                <div className="border-l-2 border-accent-500 pl-4 mb-4">
                  <p className="text-accent-300 text-sm font-semibold mb-1 uppercase tracking-wider text-[10px]">
                    Why it matters
                  </p>
                  <p className="text-white/75 text-sm leading-relaxed">
                    {briefing.leadStory.whyItMatters}
                  </p>
                </div>

                <p className="text-white/55 text-sm leading-relaxed mb-5">
                  {briefing.leadStory.summary}
                </p>

                <span className="inline-flex items-center gap-1.5 text-accent-400 text-xs font-semibold group-hover:gap-2.5 transition-all duration-200">
                  Read full story
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </div>
            </Link>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
            {/* Top Developments */}
            <div className="lg:col-span-2 space-y-8">
              {briefing.topDevelopments.length > 0 && (
                <section>
                  <div className="flex items-center gap-3 mb-5">
                    <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-navy-600 bg-slate-100 px-2.5 py-1 rounded">
                      Top Developments
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  <div className="space-y-4">
                    {briefing.topDevelopments.map((dev) => (
                      <Link
                        key={dev.id}
                        href={`/news/${dev.id}`}
                        className="group flex gap-4 p-4 rounded-lg border border-border hover:border-navy-200 hover:bg-white hover:shadow-sm transition-all duration-200"
                      >
                        <div className="shrink-0 w-1 rounded-full bg-accent-500 self-stretch" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span
                              className={`text-[10px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded ${categoryColors[dev.category] ?? categoryColors.other}`}
                            >
                              {categoryLabels[dev.category] ?? "News"}
                            </span>
                          </div>
                          <h3
                            className="text-navy-900 font-semibold text-[0.95rem] leading-snug mb-1.5 group-hover:text-navy-600 transition-colors font-playfair"
                          >
                            {dev.headline}
                          </h3>
                          <p className="text-text-muted text-sm leading-relaxed line-clamp-2">
                            {dev.summary}
                          </p>
                        </div>
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {/* What to Watch */}
              {briefing.whatToWatch.length > 0 && (
                <section>
                  <div className="flex items-center gap-3 mb-5">
                    <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-navy-600 bg-slate-100 px-2.5 py-1 rounded">
                      What to Watch
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  <div className="space-y-3">
                    {briefing.whatToWatch.map((item, i) => (
                      <div key={i} className="p-4 rounded-lg bg-white border border-border">
                        <div className="flex items-start gap-3 mb-2">
                          <span className="shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-navy-900 text-white text-[10px] font-bold mt-0.5">
                            {i + 1}
                          </span>
                          <div className="min-w-0">
                            <h4 className="font-semibold text-navy-900 text-sm leading-snug">
                              {item.event}
                            </h4>
                            <span className="inline-block mt-1 text-[9px] font-semibold tracking-wider uppercase text-navy-500 bg-navy-50 px-2 py-0.5 rounded">
                              {item.timing}
                            </span>
                          </div>
                        </div>
                        <p className="text-text-muted text-sm leading-relaxed ml-9">
                          {item.significance}
                        </p>
                        {(item as { watchMetric?: string }).watchMetric && (
                          <p className="ml-9 mt-2 text-[11px] font-semibold text-navy-700 tabular-nums">
                            <span className="text-accent-600">Watch:</span>{" "}
                            {(item as { watchMetric?: string }).watchMetric}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* Macro Snapshot Sidebar */}
            {briefing.keyData.length > 0 && (
              <aside>
                <div className="flex items-center gap-3 mb-5">
                  <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-navy-600 bg-slate-100 px-2.5 py-1 rounded">
                    Macro Snapshot
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <div className="bg-navy-900 rounded-xl overflow-hidden">
                  <div className="divide-y divide-white/10">
                    {briefing.keyData.map((dp, i) => (
                      <div key={i} className="px-5 py-3.5">
                        <p className="text-white/40 text-[9px] font-semibold tracking-widest uppercase mb-1.5">
                          {dp.label}
                        </p>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-white font-bold text-[17px] tabular-nums tracking-tight">
                            {dp.value}
                          </span>
                          {dp.change && (
                            <span
                              className={`text-[11px] font-semibold tabular-nums whitespace-nowrap ${
                                dp.change.startsWith("-")
                                  ? "text-red-400"
                                  : "text-accent-400"
                              }`}
                            >
                              {dp.change.startsWith("-") ? "▼ " : "▲ "}
                              {dp.change.replace(/^[+-]/, "")}
                            </span>
                          )}
                        </div>
                        {dp.source && (
                          <p className="text-white/25 text-[9px] mt-1 tracking-wide">
                            {dp.source}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </aside>
            )}
          </div>

          {/* View all news link */}
          <div className="pt-4 border-t border-border flex items-center justify-between">
            <Link
              href="/news"
              className="inline-flex items-center gap-2 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M12 7H2M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              View all market news
            </Link>
            <p className="text-xs text-text-light">
              Market Mountain Research
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function NoBriefingState() {
  return (
    <div className="container mx-auto px-4 sm:px-6 max-w-4xl py-16 sm:py-24">
      {/* Main empty state card */}
      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        {/* Top accent bar */}
        <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

        <div className="px-8 sm:px-12 py-12 sm:py-16 text-center">
          {/* Icon */}
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-navy-50 mb-6">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect x="3" y="18" width="5" height="9" rx="1" fill="currentColor" className="text-navy-300" />
              <rect x="11" y="12" width="5" height="15" rx="1" fill="currentColor" className="text-navy-500" />
              <rect x="19" y="6" width="5" height="21" rx="1" fill="currentColor" className="text-accent-500" />
              <path d="M4 5l7 6 6-4 8-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-navy-300" />
            </svg>
          </div>

          <h2
            className="text-2xl sm:text-3xl font-bold text-navy-900 mb-3 font-playfair"
          >
            Today&apos;s briefing is on its way
          </h2>
          <p className="text-text-muted text-base leading-relaxed mb-2 max-w-md mx-auto">
            The daily markets briefing publishes each morning once coverage is ready.
            Check back shortly for the lead story, key data, and what to watch.
          </p>
          <p className="text-text-light text-sm mb-10">
            In the meantime, browse the full news feed below.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/news"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-navy-900 hover:bg-navy-800 text-white text-sm font-semibold transition-colors"
            >
              Browse Market News
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <Link
              href="/articles"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-border hover:border-navy-300 text-text-muted hover:text-navy-900 text-sm font-medium transition-colors"
            >
              Read research articles
            </Link>
          </div>
        </div>

        {/* What to expect section */}
        <div className="border-t border-border bg-navy-50 px-8 sm:px-12 py-8">
          <p className="text-[10px] font-semibold tracking-widest uppercase text-text-light mb-5 text-center">
            What&apos;s in the daily briefing
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-2xl mx-auto">
            {[
              { label: "Lead Story", desc: "The most market-moving event of the day with analysis" },
              { label: "Key Data", desc: "Essential figures — yields, indices, macro indicators" },
              { label: "What to Watch", desc: "Forward-looking events and signals to monitor" },
            ].map((item) => (
              <div key={item.label} className="text-center">
                <p className="text-xs font-semibold text-navy-900 mb-1">{item.label}</p>
                <p className="text-xs text-text-muted leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
