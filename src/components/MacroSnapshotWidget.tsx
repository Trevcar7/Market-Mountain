"use client";

import { useState, useEffect, useRef } from "react";
import type { KeyDataPoint } from "@/lib/news-types";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function isMarketHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

  if (weekday === "Sat" || weekday === "Sun") return false;
  const minuteOfDay = hour * 60 + minute;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
}

// ---------------------------------------------------------------------------
// Display labels — must match MacroBoard.tsx to keep the two views consistent
// ---------------------------------------------------------------------------
const DISPLAY_LABEL: Record<string, string> = {
  "10-Year Yield": "10Y Treasury",
  "2-Year Yield":  "2Y Treasury",
  "Yield Curve":   "Yield Curve (10Y–2Y)",
  Unemployment:    "Unemployment Rate",
  "Broad U.S. Dollar Index": "USD Index",
  BTC: "Bitcoin",
};

// Which snapshot items go into the "Market Prices" group
const SNAPSHOT_MKT_ORDER = ["S&P 500", "VIX", "WTI Oil", "Broad U.S. Dollar Index"];
// Macro-board indicator groups (same sets as MacroBoard.tsx)
const RATE_LABELS = new Set(["Fed Funds Rate", "10-Year Yield", "2-Year Yield", "Yield Curve"]);
const ECON_LABELS = new Set(["CPI (YoY)", "Core CPI (YoY)", "Unemployment", "Nonfarm Payrolls"]);

interface DisplayItem {
  label: string;
  value: string;
  change?: string;
  source?: string;
}

/**
 * Fetch both /api/macro-board and /api/market-snapshot in parallel,
 * then combine into Market Prices → Rates → Economic Data order —
 * exactly mirroring the homepage MacroBoard.
 */
async function fetchCombinedData(): Promise<DisplayItem[]> {
  const [macroRes, snapRes] = await Promise.all([
    fetch("/api/macro-board").then((r) => r.json()).catch(() => null),
    fetch("/api/market-snapshot").then((r) => r.json()).catch(() => null),
  ]);

  const items: DisplayItem[] = [];

  // 1. Market Prices — from snapshot
  if (snapRes?.items) {
    for (const key of SNAPSHOT_MKT_ORDER) {
      const it = (snapRes.items as Array<{ label: string; value: string; change?: string; source?: string }>)
        .find((s) => s.label === key);
      if (it) {
        items.push({
          label: DISPLAY_LABEL[it.label] ?? it.label,
          value: it.value,
          change: it.change === "—" ? undefined : it.change,
          source: it.source,
        });
      }
    }
  }

  // 2. Rates — from macro-board indicators
  if (macroRes?.indicators) {
    for (const ind of macroRes.indicators as Array<{ label: string; value: string; change?: string; source?: string }>) {
      if (RATE_LABELS.has(ind.label)) {
        items.push({
          label: DISPLAY_LABEL[ind.label] ?? ind.label,
          value: ind.value,
          change: ind.change,
          source: ind.source,
        });
      }
    }
  }

  // 3. Economic Data — from macro-board indicators
  if (macroRes?.indicators) {
    for (const ind of macroRes.indicators as Array<{ label: string; value: string; change?: string; source?: string }>) {
      if (ECON_LABELS.has(ind.label)) {
        items.push({
          label: DISPLAY_LABEL[ind.label] ?? ind.label,
          value: ind.value,
          change: ind.change,
          source: ind.source,
        });
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Section header inside the dark card
// ---------------------------------------------------------------------------
function SectionHeader({ title }: { title: string }) {
  return (
    <div className="px-5 py-2.5 bg-white/[0.04]">
      <p className="text-[8px] font-bold tracking-[0.2em] uppercase text-white/30">
        {title}
      </p>
    </div>
  );
}

interface Props {
  initialData: KeyDataPoint[];
}

export default function MacroSnapshotWidget({ initialData }: Props) {
  // Convert initialData to DisplayItem[] for initial render
  const [data, setData] = useState<DisplayItem[]>(
    initialData.map((dp) => ({
      label: DISPLAY_LABEL[dp.label] ?? dp.label,
      value: dp.value,
      change: dp.change,
      source: dp.source,
    }))
  );
  const [live, setLive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const fetchFresh = async () => {
      try {
        const fresh = await fetchCombinedData();
        if (fresh.length > 0) setData(fresh);
      } catch {
        // Non-fatal — keep existing data on error
      }
    };

    const poll = async () => {
      if (!isMarketHours()) {
        setLive(false);
        return;
      }
      setLive(true);
      await fetchFresh();
    };

    // Always sync on mount so the data agrees with the MacroBoard regardless of market hours
    fetchFresh();

    // Then poll every 5 min, but only update live state during market hours
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Split data into sections for display
  const marketPriceLabels = new Set(SNAPSHOT_MKT_ORDER.map((k) => DISPLAY_LABEL[k] ?? k));
  const rateLabels = new Set([...RATE_LABELS].map((k) => DISPLAY_LABEL[k] ?? k));
  const econLabels = new Set([...ECON_LABELS].map((k) => DISPLAY_LABEL[k] ?? k));

  const marketPrices = data.filter((d) => marketPriceLabels.has(d.label));
  const rates = data.filter((d) => rateLabels.has(d.label));
  const econData = data.filter((d) => econLabels.has(d.label));
  // Anything that doesn't fit a section (e.g. initial stale data) goes at the end
  const other = data.filter(
    (d) => !marketPriceLabels.has(d.label) && !rateLabels.has(d.label) && !econLabels.has(d.label)
  );

  const sections = [
    { title: "Market Prices", items: marketPrices },
    { title: "Rates", items: rates },
    { title: "Economic Data", items: econData },
    ...(other.length > 0 ? [{ title: "Other", items: other }] : []),
  ].filter((s) => s.items.length > 0);

  return (
    <>
      <div className="flex items-center gap-3 mb-5">
        <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-navy-600 bg-slate-100 px-2.5 py-1 rounded">
          Macro Snapshot
        </span>
        {live && (
          <span className="flex items-center gap-1.5 text-[9px] font-bold tracking-widest uppercase text-accent-600">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse" />
            Live
          </span>
        )}
        <div className="flex-1 h-px bg-border" />
      </div>

      <div className="bg-navy-900 rounded-xl overflow-hidden">
        {sections.map((section) => (
          <div key={section.title}>
            <SectionHeader title={section.title} />
            <div className="divide-y divide-white/10">
              {section.items.map((dp, i) => (
                <div key={i} className="px-5 py-3">
                  <p className="text-white/40 text-[9px] font-semibold tracking-widest uppercase mb-1">
                    {dp.label}
                  </p>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-white font-bold text-[15px] tabular-nums tracking-tight">
                      {dp.value}
                    </span>
                    {dp.change && (
                      <span
                        className={`text-[11px] font-semibold tabular-nums whitespace-nowrap ${
                          dp.change.startsWith("-") ? "text-red-400" : "text-accent-400"
                        }`}
                      >
                        {dp.change.startsWith("-") ? "▼ " : "▲ "}
                        {dp.change.replace(/^[+-]/, "")}
                      </span>
                    )}
                  </div>
                  {dp.source && (
                    <p className="text-white/25 text-[8px] mt-0.5 tracking-wide">Source: {dp.source}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
