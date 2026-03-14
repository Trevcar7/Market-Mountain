"use client";

import { MarketSnapshotItem } from "@/lib/news-types";
import { useMarketData } from "@/contexts/MarketDataContext";

// Display label overrides for the strip
const STRIP_LABEL: Record<string, string> = {
  BTC:                      "Bitcoin",
  "10Y Yield":              "10Y Treasury",
  "Broad U.S. Dollar Index": "Dollar Index",
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
    <div className="flex items-center gap-1 px-2 py-2 border-r border-border/60 last:border-r-0 shrink-0">
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
        <div className="flex items-center -mx-4 sm:mx-0 px-4 sm:px-0">
          {/* Label */}
          <div className="flex items-center gap-1.5 px-2 py-2 border-r border-border/60 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-widest uppercase text-text-light whitespace-nowrap">
              Markets
            </span>
          </div>

          {/* Items */}
          {snapshot.items.map((item) => (
            <SnapshotChip key={item.label} item={item} />
          ))}

          {/* Timestamp */}
          <div className="px-2 py-2 shrink-0 ml-auto hidden xl:block">
            <span className="text-[10px] text-text-light tabular-nums">
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
