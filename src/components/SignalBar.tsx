"use client";

import { useEffect, useState } from "react";
import { SignalsCollection, MarketSignal } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// Direction icon
// ---------------------------------------------------------------------------

function DirectionIcon({ direction }: { direction: MarketSignal["direction"] }) {
  if (direction === "bullish") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="inline-block flex-shrink-0">
        <path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (direction === "bearish") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="inline-block flex-shrink-0">
        <path d="M6 2v8M10 6L6 10 2 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="inline-block flex-shrink-0">
      <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Signal card
// ---------------------------------------------------------------------------

function SignalCard({ signal }: { signal: MarketSignal }) {
  const isUp   = signal.direction === "bullish";
  const isDown = signal.direction === "bearish";

  const cardClass = isUp
    ? "bg-accent-500/10 border-accent-500/20"
    : isDown
    ? "bg-red-500/10 border-red-500/20"
    : "bg-amber-500/10 border-amber-500/20";

  const iconColor = isUp ? "text-accent-400" : isDown ? "text-red-400" : "text-amber-400";

  const badgeClass = isUp
    ? "text-accent-400 bg-accent-500/15"
    : isDown
    ? "text-red-400 bg-red-500/15"
    : "text-amber-400 bg-amber-500/15";

  const badgeLabel = isUp ? "Bullish" : isDown ? "Bearish" : "Neutral";

  return (
    <div className={`flex-shrink-0 w-56 sm:w-64 rounded-lg border p-3.5 ${cardClass}`}>
      {/* Header: asset + direction badge */}
      <div className="flex items-center gap-1.5 mb-2">
        <span className={iconColor}>
          <DirectionIcon direction={signal.direction} />
        </span>
        <span className="text-white text-xs font-bold truncate">{signal.asset}</span>
        <span className={`ml-auto text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded ${badgeClass}`}>
          {badgeLabel}
        </span>
      </div>

      {/* Statement */}
      <p className="text-white/70 text-[11px] leading-relaxed line-clamp-3">
        {signal.signal}
      </p>

      {/* Timeframe */}
      <p className="mt-2 text-[9px] font-semibold tracking-wider uppercase text-white/30">
        {signal.timeframe}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton placeholder
// ---------------------------------------------------------------------------

function SignalSkeleton() {
  return (
    <div className="flex-shrink-0 w-56 sm:w-64 rounded-lg border border-white/10 bg-white/5 p-3.5 animate-pulse">
      <div className="flex items-center gap-1.5 mb-2">
        <div className="w-3 h-3 rounded bg-white/15" />
        <div className="h-2.5 bg-white/15 rounded w-20" />
      </div>
      <div className="space-y-1.5">
        <div className="h-2 bg-white/10 rounded w-full" />
        <div className="h-2 bg-white/10 rounded w-4/5" />
        <div className="h-2 bg-white/10 rounded w-3/5" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SignalBar() {
  const [data, setData] = useState<SignalsCollection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/signals")
      .then((r) => r.json())
      .then((d: SignalsCollection) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // Don't render if no signals and not loading
  if (!loading && (!data || data.signals.length === 0)) return null;

  return (
    <div className="bg-navy-900 border-t border-white/5">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-5">
        {/* Label + subtitle */}
        <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 mb-3">
          <p className="text-[10px] font-bold tracking-widest uppercase text-white/35">
            Market Signals
          </p>
          <p className="text-white/25 text-[11px]">
            Key macro signals shaping near-term market direction
          </p>
        </div>

        {/* Horizontal scroll container */}
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap">
          {loading
            ? Array.from({ length: 3 }).map((_, i) => <SignalSkeleton key={i} />)
            : data?.signals.map((signal) => (
                <SignalCard key={signal.id} signal={signal} />
              ))}
        </div>

        {/* Timestamp */}
        {data?.generatedAt && (
          <p className="mt-3 text-[9px] text-white/20">
            Signals updated {new Date(data.generatedAt).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </p>
        )}
      </div>
    </div>
  );
}
