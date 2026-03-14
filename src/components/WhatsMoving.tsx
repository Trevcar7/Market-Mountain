"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SignalsCollection, MarketSignal } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// WhatsMoving — "What's Moving Markets" panel
// Derived from /api/signals — shows the top 3 directional drivers
// Dark-themed to visually continue the MacroBoard section.
// ---------------------------------------------------------------------------

const DIRECTION_CONFIG: Record<string, { dot: string; arrow: string; badge: string }> = {
  bullish: {
    dot:   "bg-emerald-400",
    arrow: "text-emerald-400",
    badge: "text-emerald-300 bg-emerald-500/15 border-emerald-500/20",
  },
  bearish: {
    dot:   "bg-red-400",
    arrow: "text-red-400",
    badge: "text-red-300 bg-red-500/15 border-red-500/20",
  },
  neutral: {
    dot:   "bg-amber-400",
    arrow: "text-amber-400",
    badge: "text-amber-300 bg-amber-500/15 border-amber-500/20",
  },
};

function DirectionArrow({ direction }: { direction: MarketSignal["direction"] }) {
  if (direction === "bullish") return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="inline-block shrink-0">
      <path d="M5 8V2M2 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (direction === "bearish") return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="inline-block shrink-0">
      <path d="M5 2v6M2 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="inline-block shrink-0">
      <path d="M1.5 5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function SignalRow({ signal, index }: { signal: MarketSignal; index: number }) {
  const cfg = DIRECTION_CONFIG[signal.direction] ?? DIRECTION_CONFIG.neutral;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-white/[0.06] last:border-0">
      {/* Index + direction dot */}
      <div className="shrink-0 flex flex-col items-center gap-1.5 mt-[2px]">
        <span className="text-[9px] font-bold text-white/20 tabular-nums">{index + 1}</span>
        <span className={`block w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      </div>

      {/* Asset + signal */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`inline-flex items-center gap-1 border text-[10px] font-bold tracking-wide uppercase px-2 py-0.5 rounded ${cfg.badge} ${cfg.arrow}`}>
            <DirectionArrow direction={signal.direction} />
            {signal.asset}
          </span>
          {signal.timeframe && (
            <span className="text-[9px] text-white/25 font-medium uppercase tracking-wider truncate">
              {signal.timeframe}
            </span>
          )}
        </div>
        <p className="text-white/65 text-[12px] leading-relaxed">
          {signal.signal}
        </p>
      </div>

      {/* Confidence pip */}
      <div className="shrink-0 mt-1.5">
        <span
          className={`block w-1.5 h-1.5 rounded-full ${
            signal.confidence === "high"
              ? "bg-emerald-400"
              : signal.confidence === "medium"
              ? "bg-amber-400"
              : "bg-white/20"
          }`}
          title={`${signal.confidence} confidence`}
        />
      </div>
    </div>
  );
}

export default function WhatsMoving() {
  const [signals, setSignals] = useState<MarketSignal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals");
        if (!res.ok) return;
        const json = (await res.json()) as SignalsCollection;
        if (json.signals?.length > 0) {
          const sorted = [...json.signals].sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return (order[a.confidence] ?? 2) - (order[b.confidence] ?? 2);
          });
          setSignals(sorted.slice(0, 3));
        }
      } catch {
        // Fail silently — panel doesn't render
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading || signals.length === 0) return null;

  return (
    <section className="bg-navy-950 border-t border-white/[0.06] text-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            {/* Pulse dot */}
            <span className="w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse shrink-0" aria-hidden="true" />
            <p className="text-[9px] font-bold tracking-[0.16em] uppercase text-white/40">
              What&apos;s Moving Markets
            </p>
            <span className="text-[9px] font-semibold text-white/20 uppercase tracking-widest hidden sm:inline">
              AI Signals
            </span>
          </div>
          <Link
            href="/news"
            className="text-[10px] font-medium text-accent-400 hover:text-accent-300 transition-colors flex items-center gap-1"
          >
            View news
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>

        {/* Signal rows */}
        <div>
          {signals.map((signal, i) => (
            <SignalRow key={signal.id} signal={signal} index={i} />
          ))}
        </div>

        {/* Confidence legend */}
        <div className="mt-3 flex items-center gap-3.5 text-[9px] text-white/20">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            High confidence
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Medium
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
            Low
          </span>
        </div>

      </div>
    </section>
  );
}
