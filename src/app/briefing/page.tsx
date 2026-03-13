import type { Metadata } from "next";
import { Redis } from "@upstash/redis";
import Link from "next/link";
import { DailyBriefing } from "@/lib/news-types";

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

const categoryLabels: Record<string, string> = {
  macro: "Macro",
  earnings: "Earnings",
  markets: "Markets",
  policy: "Policy",
  crypto: "Crypto",
  other: "News",
};

const categoryColors: Record<string, string> = {
  macro: "bg-blue-100 text-blue-800",
  earnings: "bg-purple-100 text-purple-800",
  markets: "bg-amber-100 text-amber-800",
  policy: "bg-teal-100 text-teal-800",
  crypto: "bg-orange-100 text-orange-800",
  other: "bg-slate-100 text-slate-700",
};

async function getBriefing(): Promise<DailyBriefing | null> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const date = new Date().toISOString().split("T")[0];
  const key = `briefing-${date}`;

  try {
    const kv = new Redis({ url, token });
    const briefing = await kv.get<DailyBriefing>(key);
    return briefing ?? null;
  } catch {
    return null;
  }
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
            className="font-bold text-4xl sm:text-5xl leading-tight mb-4"
            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
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
                  className="text-2xl sm:text-[1.9rem] font-bold text-white leading-tight mb-4 group-hover:text-accent-300 transition-colors duration-200"
                  style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
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
                              className={`text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded ${categoryColors[dev.category] ?? categoryColors.other}`}
                            >
                              {categoryLabels[dev.category] ?? "News"}
                            </span>
                          </div>
                          <h3
                            className="text-navy-900 font-semibold text-[0.95rem] leading-snug mb-1.5 group-hover:text-navy-600 transition-colors"
                            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
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
                      <div key={i} className="flex gap-4 p-4 rounded-lg bg-white border border-border">
                        <div className="shrink-0 mt-0.5">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-navy-900 text-white text-[10px] font-bold">
                            {i + 1}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-2 mb-1">
                            <span className="font-semibold text-navy-900 text-sm">{item.event}</span>
                            <span className="text-text-light text-xs">{item.timing}</span>
                          </div>
                          <p className="text-text-muted text-sm leading-relaxed">
                            {item.significance}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* Key Data Sidebar */}
            {briefing.keyData.length > 0 && (
              <aside>
                <div className="flex items-center gap-3 mb-5">
                  <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-navy-600 bg-slate-100 px-2.5 py-1 rounded">
                    Key Data
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <div className="bg-navy-900 rounded-xl overflow-hidden">
                  <div className="divide-y divide-white/10">
                    {briefing.keyData.map((dp, i) => (
                      <div key={i} className="px-5 py-4">
                        <p className="text-white/45 text-[10px] font-semibold tracking-wider uppercase mb-1">
                          {dp.label}
                        </p>
                        <div className="flex items-baseline gap-2">
                          <span className="text-white font-bold text-lg">{dp.value}</span>
                          {dp.change && (
                            <span
                              className={`text-xs font-semibold ${
                                dp.change.startsWith("-")
                                  ? "text-red-400"
                                  : "text-accent-400"
                              }`}
                            >
                              {dp.change}
                            </span>
                          )}
                        </div>
                        {dp.source && (
                          <p className="text-white/30 text-[9px] mt-0.5">{dp.source}</p>
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
    <div className="container mx-auto px-4 sm:px-6 max-w-4xl py-20 text-center">
      <div className="max-w-md mx-auto">
        <p className="text-4xl mb-4" role="img" aria-label="chart">
          📊
        </p>
        <h2
          className="text-xl font-bold text-navy-900 mb-3"
          style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
        >
          Briefing not yet available
        </h2>
        <p className="text-text-muted text-sm mb-6">
          Today&apos;s briefing will be available once the morning market coverage
          is ready. Check back shortly, or browse the full news feed.
        </p>
        <Link
          href="/news"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-navy-900 hover:bg-navy-800 text-white text-sm font-medium transition-colors"
        >
          Browse Market News
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
