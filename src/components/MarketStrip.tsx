"use client";

import { useEffect, useState } from "react";
import { MarketSnapshotData, MarketSnapshotItem } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// MarketStrip — live market price ticker
// Auto-refreshes every 60 seconds. Graceful fallback on API failure.
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

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-r border-border/60 last:border-r-0 shrink-0">
      <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase whitespace-nowrap">
        {item.label}
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
  const [data, setData] = useState<MarketSnapshotData | null>(null);
  const [error, setError] = useState(false);

  async function loadData() {
    try {
      const res = await fetch("/api/market-snapshot", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const json = (await res.json()) as MarketSnapshotData;
      if (json.items && json.items.length > 0) {
        setData(json);
        setError(false);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60_000); // refresh every 60s
    return () => clearInterval(interval);
  }, []);

  // Don't render at all if no data and no error (avoids layout shift on initial SSR)
  if (!data && !error) return null;

  // Silent failure — strip disappears rather than showing an error state
  // Require at least 3 items to avoid a sparse single-item ticker
  if (error || !data || data.items.length < 3) return null;

  return (
    <div
      className="w-full bg-white border-b border-border overflow-hidden"
      aria-label="Live market prices"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center overflow-x-auto scrollbar-none -mx-4 sm:mx-0 px-4 sm:px-0">
          {/* Label */}
          <div className="flex items-center gap-1.5 px-4 py-2 border-r border-border/60 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-widest uppercase text-text-light whitespace-nowrap">
              Markets
            </span>
          </div>

          {/* Items */}
          {data.items.map((item) => (
            <SnapshotChip key={item.label} item={item} />
          ))}

          {/* Timestamp */}
          <div className="px-4 py-2 shrink-0 ml-auto hidden sm:block">
            <span className="text-[10px] text-text-light tabular-nums">
              {new Date(data.generatedAt).toLocaleTimeString("en-US", {
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
