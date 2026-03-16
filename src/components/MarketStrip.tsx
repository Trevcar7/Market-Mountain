"use client";

import { MarketSnapshotItem } from "@/lib/news-types";
import { useMarketData } from "@/contexts/MarketDataContext";

// Display label overrides for the strip
const STRIP_LABEL: Record<string, string> = {
  BTC:                       "BTC",
  "10Y Yield":               "10Y",
  "Broad U.S. Dollar Index": "DXY",
};

// ---------------------------------------------------------------------------
// MarketStrip — live market price ticker
// Consumes shared MarketDataContext — no independent fetch or polling.
// ---------------------------------------------------------------------------

function DirectionArrow({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="inline-block">
        <path d="M5 8V2M2 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (direction === "down") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="inline-block">
        <path d="M5 2v6M2 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return <span aria-hidden="true">—</span>;
}

function SnapshotChip({ item }: { item: MarketSnapshotItem }) {
  const isUp   = item.direction === "up";
  const isDown = item.direction === "down";

  // Ticker colors reflect price movement direction only (up=green, down=red).
  // Macro interpretation is handled by the signal badges in the dashboard below.
  const changeColor = isUp
    ? "text-emerald-600"
    : isDown
    ? "text-red-500"
    : "text-slate-400";

  const displayLabel = STRIP_LABEL[item.label] ?? item.label;

  return (
    <div className="flex items-center justify-center gap-1.5 px-4 sm:px-6 py-2 border-r border-border/60 last:border-r-0">
      <span className="text-[10px] font-medium tracking-wide text-text-muted uppercase whitespace-nowrap">
        {displayLabel}
      </span>
      <span className="text-[15px] font-bold text-navy-900 whitespace-nowrap tabular-nums leading-none">
        {item.value}
      </span>
      <span className={`text-[11px] font-semibold flex items-center gap-0.5 whitespace-nowrap tabular-nums leading-none ${changeColor}`}>
        <DirectionArrow direction={item.direction} />
        {item.change}
      </span>
    </div>
  );
}

export default function MarketStrip() {
  const { snapshot, loading } = useMarketData();

  if (loading) return (
    <div className="w-full bg-white sm:overflow-hidden" aria-hidden="true">
      <div className="h-px bg-gradient-to-r from-transparent via-accent-500/40 to-transparent" />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center h-10 gap-6 animate-pulse">
          <div className="shrink-0 flex items-center gap-1.5 px-2 border-r border-border/60">
            <div className="w-1.5 h-1.5 rounded-full bg-slate-200" />
            <div className="h-2 bg-slate-200 rounded w-12" />
          </div>
          <div className="flex-1 flex items-center sm:justify-center gap-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-2 items-center px-4 sm:px-6 border-r border-border/60 last:border-0 py-2">
                <div className="h-2 bg-slate-200 rounded w-8" />
                <div className="h-3 bg-slate-200 rounded w-12" />
                <div className="h-2 bg-slate-200 rounded w-10" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="h-px bg-gradient-to-r from-transparent via-accent-500/40 to-transparent" />
    </div>
  );

  // Silent failure — strip disappears rather than showing an error state
  // Require at least 3 items to avoid a sparse single-item ticker
  if (!snapshot || snapshot.items.length < 3) return null;

  return (
    <div
      className="w-full bg-white sm:overflow-hidden"
      aria-label="Live market prices"
    >
      {/* Top accent line — fading green matching the site accent divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-accent-500/40 to-transparent" />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center">
          {/* Left: Markets label — natural width, stays fixed while chips scroll on mobile */}
          <div className="shrink-0 flex items-center gap-1.5 px-2 py-2 border-r border-border/60">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-widest uppercase text-text-light whitespace-nowrap">
              Markets
            </span>
          </div>

          {/* Center: scrollable on mobile, centered on sm+ */}
          <div className="flex-1 flex items-center overflow-x-auto scrollbar-none px-3 sm:px-0 sm:justify-center sm:overflow-visible">
            {snapshot.items.map((item) => (
              <SnapshotChip key={item.label} item={item} />
            ))}
          </div>

          {/* Right: invisible mirror to keep chips centered on sm+. Hidden on mobile. */}
          <div className="hidden sm:flex shrink-0 relative items-center gap-1.5 px-2 py-2">
            <span className="w-1.5 h-1.5 rounded-full opacity-0" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-widest uppercase opacity-0 whitespace-nowrap" aria-hidden="true">
              Markets
            </span>
            <span className="absolute inset-0 hidden xl:flex items-center justify-end pr-2 text-[10px] text-text-light tabular-nums whitespace-nowrap">
              {new Date(snapshot.generatedAt).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
              })}
            </span>
          </div>
        </div>
      </div>
      {/* Bottom accent line — fading green matching the site accent divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-accent-500/40 to-transparent" />
    </div>
  );
}
