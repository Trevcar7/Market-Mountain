import type { Metadata } from "next";
import Link from "next/link";
import { getRedisClient } from "@/lib/redis";
import { DailyBriefing } from "@/lib/news-types";

export const metadata: Metadata = {
  title: "Briefing Archive | Market Mountain",
  description:
    "Archive of past daily markets briefings — lead stories, key data, and what to watch from prior trading days.",
  alternates: { canonical: "/briefing/archive" },
};

// Revalidate hourly — new briefings appear once per day
export const revalidate = 3600;

interface ArchiveEntry {
  date: string;
  generatedAt: string;
  leadTitle: string;
  whyItMatters: string;
  storiesPublished: number;
}

async function getArchive(): Promise<ArchiveEntry[]> {
  const kv = getRedisClient();
  if (!kv) return [];

  try {
    // Scan all briefing-* keys (Upstash supports SCAN with MATCH).
    // Volume is small (one per day), so a single scan pass is fine.
    const keys: string[] = [];
    let cursor: string | number = 0;
    while (true) {
      const result: [string | number, string[]] = await kv.scan(cursor, { match: "briefing-*", count: 100 });
      const [next, batch] = result;
      keys.push(...batch);
      if (next === 0 || next === "0") break;
      cursor = next;
    }

    if (keys.length === 0) return [];

    // Fetch all briefings in parallel
    const briefings = await Promise.all(
      keys.map((key) => kv.get<DailyBriefing>(key).catch(() => null))
    );

    return briefings
      .filter((b): b is DailyBriefing => b !== null && Boolean(b.date))
      .map((b) => ({
        date: b.date,
        generatedAt: b.generatedAt,
        leadTitle: b.leadStory?.title ?? "Markets briefing",
        whyItMatters: b.leadStory?.whyItMatters ?? "",
        storiesPublished: b.storiesPublished ?? 0,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
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

export default async function BriefingArchivePage() {
  const entries = await getArchive();
  const today = new Date().toISOString().split("T")[0];

  return (
    <main className="min-h-screen bg-surface">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-9 sm:py-16">
        <div className="container mx-auto px-4 sm:px-6 max-w-4xl">
          <nav className="flex items-center gap-1.5 text-[11px] text-white/35 mb-4" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-white/60 transition-colors">Home</Link>
            <span aria-hidden="true">/</span>
            <Link href="/briefing" className="hover:text-white/60 transition-colors">Briefing</Link>
            <span aria-hidden="true">/</span>
            <span className="text-white/55">Archive</span>
          </nav>
          <p className="text-xs font-semibold tracking-widest uppercase text-accent-400 mb-3">
            Briefing Archive
          </p>
          <h1 className="font-bold text-3xl sm:text-5xl leading-tight mb-3 sm:mb-4 font-playfair">
            Past Daily Briefings
          </h1>
          <p className="text-white/55 text-sm max-w-2xl">
            A record of every published markets briefing. Each entry links to the full lead story, top developments, and what was on the watch list that day.
          </p>
        </div>
      </section>

      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

      <div className="container mx-auto px-4 sm:px-6 max-w-4xl py-10 sm:py-16">
        {entries.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-text-muted text-sm">
              No briefings have been published yet.{" "}
              <Link href="/briefing" className="text-accent-600 hover:text-accent-700 font-medium underline">
                Check today&apos;s briefing
              </Link>
              .
            </p>
          </div>
        ) : (
          <ol className="space-y-3">
            {entries.map((entry) => {
              const isToday = entry.date === today;
              return (
                <li key={entry.date}>
                  <Link
                    href={`/briefing/${entry.date}`}
                    className="group block p-5 sm:p-6 rounded-lg bg-card border border-border hover:border-accent-300 hover:shadow-sm transition-all duration-200"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 mb-2">
                      <p className="text-[11px] font-bold tracking-widest uppercase text-text-light">
                        {formatLongDate(entry.date)}
                      </p>
                      {isToday && (
                        <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-accent-700 bg-accent-500/15 px-2 py-0.5 rounded self-start sm:self-auto">
                          Today
                        </span>
                      )}
                    </div>
                    <h2 className="text-base sm:text-lg font-semibold text-text leading-snug group-hover:text-accent-700 transition-colors font-playfair mb-1.5">
                      {entry.leadTitle}
                    </h2>
                    {entry.whyItMatters && (
                      <p className="text-text-muted text-sm leading-relaxed line-clamp-2">
                        {entry.whyItMatters}
                      </p>
                    )}
                    <div className="mt-3 flex items-center justify-between text-[11px] text-text-light">
                      <span>{entry.storiesPublished} {entry.storiesPublished === 1 ? "story" : "stories"} published</span>
                      <span className="inline-flex items-center gap-1 text-accent-600 group-hover:gap-2 transition-all">
                        Read briefing
                        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}

        <div className="mt-10 pt-6 border-t border-border">
          <Link
            href="/briefing"
            className="inline-flex items-center gap-2 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M12 7H2M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to today&apos;s briefing
          </Link>
        </div>
      </div>
    </main>
  );
}
