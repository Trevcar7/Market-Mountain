import type { Metadata } from "next";
import { getRedisClient } from "@/lib/redis";
import { notFound } from "next/navigation";
import Link from "next/link";
import { DailyBriefing } from "@/lib/news-types";
import { categoryLabelsShort as categoryLabels, categoryColors } from "@/lib/category-config";
import MacroSnapshotWidget from "@/components/MacroSnapshotWidget";

interface Props {
  params: Promise<{ date: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { date } = await params;
  return {
    title: `Markets Briefing — ${date} | Market Mountain`,
    description: `Daily markets briefing for ${date} — lead story, top developments, key data, and what to watch.`,
    alternates: { canonical: `/briefing/${date}` },
    openGraph: {
      title: `Markets Briefing — ${date} | Market Mountain`,
      description: `Daily markets briefing for ${date} — lead story, top developments, key data, and what to watch.`,
      type: "article",
    },
  };
}

async function getBriefing(date: string): Promise<DailyBriefing | null> {
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const kv = getRedisClient();
  if (!kv) return null;

  try {
    const briefing = await kv.get<DailyBriefing>(`briefing-${date}`);
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

export default async function BriefingDatePage({ params }: Props) {
  const { date } = await params;
  const briefing = await getBriefing(date);

  if (!briefing) notFound();

  const isToday = date === new Date().toISOString().split("T")[0];

  return (
    <main className="min-h-screen bg-surface">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-14 sm:py-20">
        <div className="container mx-auto px-4 sm:px-6 max-w-4xl">
          <nav className="flex items-center gap-1.5 text-[11px] text-white/35 mb-4" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-white/60 transition-colors">Home</Link>
            <span aria-hidden="true">/</span>
            <Link href="/briefing" className="hover:text-white/60 transition-colors">Briefing</Link>
            <span aria-hidden="true">/</span>
            <span className="text-white/55">{date}</span>
          </nav>
          <p className="text-xs font-semibold tracking-widest uppercase text-accent-400 mb-3">
            Daily Markets Briefing
          </p>
          <h1
            className="font-bold text-4xl sm:text-5xl leading-tight mb-4 font-playfair"
          >
            {formatLongDate(briefing.date)}
          </h1>
          <p className="text-white/55 text-sm">
            {`Updated ${formatUpdateTime(briefing.generatedAt)}`}
          </p>
          {isToday && (
            <span className="inline-block mt-3 text-[10px] font-bold tracking-widest uppercase text-accent-400 bg-accent-400/10 px-2.5 py-1 rounded border border-accent-400/20">
              Today
            </span>
          )}
        </div>
      </section>

      {/* Accent divider */}
      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

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
          {/* Top Developments + What to Watch */}
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

          {/* Macro Snapshot Sidebar — polls /api/briefing-macro every 5 min during market hours */}
          {briefing.keyData.length > 0 && (
            <aside>
              <MacroSnapshotWidget initialData={briefing.keyData} />
            </aside>
          )}
        </div>

        {/* Footer nav */}
        <div className="pt-4 border-t border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <Link
              href="/briefing"
              className="inline-flex items-center gap-2 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M12 7H2M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Today&apos;s briefing
            </Link>
            <Link
              href="/news"
              className="text-sm font-medium text-text-muted hover:text-navy-900 transition-colors"
            >
              All market news
            </Link>
          </div>
          <p className="text-xs text-text-light">
            Market Mountain Research
          </p>
        </div>
      </div>
    </main>
  );
}
