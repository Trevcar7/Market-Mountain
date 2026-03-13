"use client";

import { useEffect, useState } from "react";
import { MacroBoardData, MacroIndicator } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// Direction arrow icon
// ---------------------------------------------------------------------------

function DirectionArrow({ direction }: { direction: MacroIndicator["direction"] }) {
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
        <path d="M5 2v6M8 5L5 8 2 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="inline-block">
      <path d="M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Regime badge
// ---------------------------------------------------------------------------

function RegimeBadge({ tag }: { tag: string }) {
  let colorClass = "bg-white/10 text-white/60";

  if (tag.includes("Restrictive") || tag.includes("Tightening") || tag.includes("Shock")) {
    colorClass = "bg-red-500/15 text-red-300";
  } else if (tag.includes("Easing") || tag.includes("Accommodative") || tag.includes("Disinflation")) {
    colorClass = "bg-accent-500/15 text-accent-300";
  } else if (tag.includes("Tight")) {
    colorClass = "bg-amber-500/15 text-amber-300";
  } else if (tag.includes("Cooling") || tag.includes("Deflationary")) {
    colorClass = "bg-blue-500/15 text-blue-300";
  }

  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider uppercase ${colorClass}`}>
      {tag}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skeleton placeholder
// ---------------------------------------------------------------------------

function IndicatorSkeleton() {
  return (
    <div className="px-4 py-3.5 animate-pulse">
      <div className="h-2 bg-white/10 rounded w-16 mb-2" />
      <div className="h-5 bg-white/15 rounded w-20" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function MacroBoard() {
  const [data, setData] = useState<MacroBoardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/macro-board")
      .then((r) => r.json())
      .then((d: MacroBoardData) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // Don't render at all if load failed with no data and no indicators
  if (!loading && (!data || data.indicators.length === 0)) return null;

  return (
    <div className="bg-navy-900 text-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] font-bold tracking-widest uppercase text-white/35">
            Macro Board
          </p>
          {data?.regimeTags && data.regimeTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-end">
              {data.regimeTags.map((tag) => (
                <RegimeBadge key={tag} tag={tag} />
              ))}
            </div>
          )}
        </div>

        {/* Indicator grid */}
        <div className="bg-white/5 rounded-xl overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-white/10">
            {loading
              ? Array.from({ length: 6 }).map((_, i) => <IndicatorSkeleton key={i} />)
              : data?.indicators.map((indicator) => {
                  const isUp = indicator.direction === "up";
                  const isDown = indicator.direction === "down";
                  const changeColor = isUp
                    ? "text-red-400"   // Up rate/inflation = bad (red)
                    : isDown
                    ? "text-accent-400" // Down rate/inflation = good (green)
                    : "text-white/40";

                  // For indicators where "up" is good (e.g., Payrolls), invert the color
                  const positiveUpLabels = ["Nonfarm Payrolls"];
                  const isPositiveUp = positiveUpLabels.includes(indicator.label);
                  const displayColor = isPositiveUp
                    ? isUp ? "text-accent-400" : isDown ? "text-red-400" : "text-white/40"
                    : changeColor;

                  return (
                    <div key={indicator.label} className="px-4 py-3.5">
                      <p className="text-white/40 text-[9px] font-semibold tracking-wider uppercase mb-0.5 whitespace-nowrap overflow-hidden text-ellipsis">
                        {indicator.label}
                      </p>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-white font-bold text-base leading-tight">
                          {indicator.value}
                        </span>
                        {indicator.change && (
                          <span className={`text-[10px] font-semibold flex items-center gap-0.5 ${displayColor}`}>
                            <DirectionArrow direction={indicator.direction} />
                            {indicator.change}
                          </span>
                        )}
                      </div>
                      <p className="text-white/20 text-[9px] mt-0.5">{indicator.source}</p>
                    </div>
                  );
                })}
          </div>
        </div>
      </div>
    </div>
  );
}
