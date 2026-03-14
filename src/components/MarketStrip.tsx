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

  const changeColor = isUp
    ? "text-emerald-600"
    : isDown
    ? "text-red-500"
    : "text-slate-400";

  const displayLabel = STRIP_LABEL[item.label] ?? item.label;

  return (
    <div className="flex items-center justify-center gap-0.5 px-3 sm:px-4 py-2 border-r border-border/60 last:border-r-0">
      <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase whitespace-nowrap">
        {displayLabel}
      </span>
      <span className="text-[13px] font-bold text-navy-900 whitespace-nowrap tabular-nums">
        {item.value}
      </span>
      <span className={`text-[11px] font-semibold flex items-center gap-0.5 whitespace-nowrap tabular-nums ${changeColor}`}>
        <DirectionArrow direction={item.direction} />
        {item.change}
      </span>
    </div>
  );
}

export default function MarketStrip() {
  const { snapshot, loading } = useMarketData();

  // Don't render at all until initial data arrives (avoids layout shift on SSR)
  if (loading) return null;

  // Silent failure — strip disappears rather than showing an error state
  // Require at least 3 items to avoid a sparse single-item ticker
  if (!snapshot || snapshot.items.length < 3) return null;

  return (
    <div
      className="w-full bg-white border-b border-border overflow-hidden"
      aria-label="Live market prices"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center">
          {/* Left: Markets label — natural width */}
          <div className="shrink-0 flex items-center gap-1.5 px-2 py-2 border-r border-border/60">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-widest uppercase text-text-light whitespace-nowrap">
              Markets
            </span>
          </div>

          {/* Center: chips at natural widths, centered in the remaining flex space */}
          <div className="flex-1 flex items-center justify-center">
            {snapshot.items.map((item) => (
              <SnapshotChip key={item.label} item={item} />
            ))}
          </div>

          {/* Right: always exactly as wide as the left label (invisible mirror sets width).
              Timestamp is absolutely overlaid at xl+ so it never affects layout width. */}
          <div className="shrink-0 relative flex items-center gap-1.5 px-2 py-2">
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
    </div>
  );
}
