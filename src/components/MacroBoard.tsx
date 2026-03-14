"use client";

import { useEffect, useRef, useState } from "react";
import { MacroBoardData, MacroIndicator } from "@/lib/news-types";
import { useMarketData } from "@/contexts/MarketDataContext";

// ─── Display config ───────────────────────────────────────────────────────────

const DISPLAY_LABEL: Record<string, string> = {
  "10-Year Yield": "10Y Treasury",
  "2-Year Yield":  "2Y Treasury",
  "Yield Curve":   "Yield Curve (10Y–2Y)",
  Unemployment:    "Unemployment Rate",
  // Snapshot label → human-readable Market Prices name
  BTC: "Bitcoin",
};

// Macro-board labels per section
const RATE_LABELS = new Set(["Fed Funds Rate", "10-Year Yield", "2-Year Yield", "Yield Curve"]);
const ECON_LABELS = new Set(["CPI (YoY)", "Core CPI (YoY)", "Unemployment", "Nonfarm Payrolls"]);

// Snapshot items to include in Market Prices section (10Y Yield excluded — lives in Rates)
const SNAPSHOT_MKT = new Set(["S&P 500", "VIX", "WTI Oil", "Gold", "BTC", "USD Index"]);

// Preferred display order for Market Prices
const MARKET_ORDER = ["S&P 500", "VIX", "WTI Oil", "Gold", "USD Index", "BTC"];

// Labels where UP = bullish (green)
const POSITIVE_UP = new Set(["S&P 500", "Nonfarm Payrolls", "Bitcoin", "BTC", "Gold"]);

// Labels where UP = bearish (red)
const NEGATIVE_UP = new Set([
  "Fed Funds Rate", "10Y Treasury", "10-Year Yield",
  "2Y Treasury", "2-Year Yield",
  "VIX", "CPI (YoY)", "Core CPI (YoY)",
]);

// Static border class maps — written out in full so Tailwind includes them
const SECTION_BORDER: Record<1 | 2 | 3, string> = {
  1: "border-b border-white/[0.07] last:border-b-0",
  2: "border-b sm:border-b-0 sm:border-r sm:last:border-r-0 border-white/[0.07]",
  3: "border-b lg:border-b-0 lg:border-r lg:last:border-r-0 border-white/[0.07]",
};

const GRID_CLASS: Record<0 | 1 | 2 | 3, string> = {
  0: "grid-cols-1",
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 lg:grid-cols-3",
};

interface DisplayItem {
  label:        string;
  displayLabel: string;
  value:        string;
  change?:      string;
  direction:    "up" | "down" | "flat";
  source:       string;
  sparkPoints?: number[];
}

// ─── Client-side refresh interval (ET-aware) ─────────────────────────────────

function getClientRefreshMs(): number {
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const day = etNow.getDay();
  const tm  = etNow.getHours() * 60 + etNow.getMinutes();
  if (day >= 1 && day <= 5 && tm >= 9 * 60 + 30 && tm < 16 * 60) return 60_000;
  return 5 * 60_000;
}

// ─── Sparkline ────────────────────────────────────────────────────────────────
// Minimal inline SVG trendline — no external library, no fill.

const SPARK_COLORS: Record<"up" | "down" | "flat", string> = {
  up:   "#10b981", // emerald-500
  down: "#ef4444", // red-500
  flat: "#475569", // slate-600
};

function Sparkline({ points, direction }: { points: number[]; direction: "up" | "down" | "flat" }) {
  if (points.length < 2) return null;

  const W = 56, H = 18, PAD = 1;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const coords = points.map((v, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (v - min) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      className="shrink-0"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke={SPARK_COLORS[direction]}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.75"
      />
    </svg>
  );
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function getChangeColor(label: string, displayLabel: string, direction: "up" | "down" | "flat"): string {
  if (direction === "flat") return "text-white/35";
  if (label === "Yield Curve")
    return direction === "up" ? "text-emerald-400" : "text-red-400";
  if (POSITIVE_UP.has(label) || POSITIVE_UP.has(displayLabel))
    return direction === "up" ? "text-emerald-400" : "text-red-400";
  if (NEGATIVE_UP.has(label) || NEGATIVE_UP.has(displayLabel))
    return direction === "up" ? "text-red-400" : "text-emerald-400";
  return direction === "up" ? "text-emerald-400" : "text-red-400";
}

// ─── Simple signal tags — derived from raw indicator values ──────────────────

interface SignalTag { label: string; colorClass: string; }

function buildSignalTags(indicators: MacroIndicator[]): SignalTag[] {
  const tags: SignalTag[] = [];

  const fedRate    = indicators.find((i) => i.label === "Fed Funds Rate");
  const coreCpi    = indicators.find((i) => i.label === "Core CPI (YoY)");
  const cpi        = indicators.find((i) => i.label === "CPI (YoY)");

  // Rates tag — only show when clearly elevated
  if (fedRate) {
    const rate = parseFloat(fedRate.value);
    if (rate > 4.0) {
      tags.push({ label: `Rates Elevated (${fedRate.value})`, colorClass: "bg-red-500/15 text-red-300 border-red-500/25" });
    } else if (rate < 1.5) {
      tags.push({ label: `Rates Near Zero (${fedRate.value})`, colorClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25" });
    }
  }

  // Inflation tag — use Core CPI (Fed's preferred); fall back to headline
  const inflationInd = coreCpi ?? cpi;
  if (inflationInd) {
    const val = parseFloat(inflationInd.value);
    if (val > 2.5) {
      const label = coreCpi ? "Core CPI" : "CPI";
      tags.push({ label: `Inflation Above Target (${label} ${inflationInd.value})`, colorClass: "bg-amber-500/15 text-amber-300 border-amber-500/25" });
    }
  }

  return tags;
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function ArrowIcon({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" className="inline-block shrink-0" aria-hidden="true">
      <path d="M4.5 7.5V1.5M2 4l2.5-2.5L7 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (direction === "down") return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" className="inline-block shrink-0" aria-hidden="true">
      <path d="M4.5 1.5v6M2 5l2.5 2.5L7 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" className="inline-block shrink-0" aria-hidden="true">
      <path d="M1.5 4.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function IndicatorIcon({ label }: { label: string }) {
  const cls = "w-[11px] h-[11px] shrink-0 text-white/25";
  if (label === "S&P 500") return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <polyline points="1,9 3,6 5,7.5 7.5,3.5 9,5 11,2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (label === "VIX") return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <polyline points="1,6 3,3 5,9 7,3 9,9 11,6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (label.includes("Oil") || label.includes("WTI")) return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <path d="M6 1.5C6 1.5 9.5 6 9.5 7.8C9.5 9.6 7.9 11 6 11C4.1 11 2.5 9.6 2.5 7.8C2.5 6 6 1.5 6 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  );
  if (label.includes("Dollar") || label === "DXY" || label === "USD Index") return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <path d="M6 1.5V10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M3.5 4C3.5 3.2 4.7 2.5 6 2.5C7.3 2.5 8.5 3.2 8.5 4C8.5 5 7 5.5 6 5.5C4.8 5.5 3.5 6 3.5 7C3.5 7.8 4.7 8.5 6 8.5C7.3 8.5 8.5 7.8 8.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
  if (label === "Gold") return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1"/>
    </svg>
  );
  if (label.includes("Bitcoin") || label === "BTC") return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <path d="M5 2H8C9 2 9.8 2.8 9.8 3.8C9.8 4.8 9 5.5 8 5.5H5V2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M5 5.5H8.5C9.5 5.5 10.2 6.3 10.2 7.3C10.2 8.3 9.5 9 8.5 9H5V5.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M4 1.5V9.5M7 2V1M7 9.5V10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
  if (label.includes("Fed")) return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <path d="M1 11H11M2 11V7M4.5 11V7M7.5 11V7M10 11V7M1 6.5L6 2L11 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (label.includes("Treasury") || label.includes("Yield")) return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <circle cx="3.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
      <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
  if (label.includes("CPI")) return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <path d="M4.5 1H9.5L11 2.5V7.5L6 11L1 6L4.5 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <circle cx="8" cy="3.5" r="1" fill="currentColor"/>
    </svg>
  );
  if (label.includes("Unemploy")) return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <circle cx="6" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M1.5 11C1.5 8.5 3.5 6.5 6 6.5C8.5 6.5 10.5 8.5 10.5 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
  if (label.includes("Payroll") || label.includes("Nonfarm")) return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <rect x="1.5" y="5.5" width="9" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M4.5 5.5V4C4.5 3.4 5 3 5.5 3H6.5C7 3 7.5 3.4 7.5 4V5.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <line x1="1.5" y1="8" x2="10.5" y2="8" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
  return null;
}

function SectionIcon({ type }: { type: "market" | "rates" | "econ" }) {
  const cls = "w-3.5 h-3.5 shrink-0 text-white/30";
  if (type === "market") return (
    <svg viewBox="0 0 14 14" fill="none" className={cls} aria-hidden="true">
      <polyline points="1,11 3.5,7.5 5.5,9 8,5 10,7 13,3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (type === "rates") return (
    <svg viewBox="0 0 14 14" fill="none" className={cls} aria-hidden="true">
      <path d="M2 3C5 3 5 11 7 11C9 11 9 3 12 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
  return (
    <svg viewBox="0 0 14 14" fill="none" className={cls} aria-hidden="true">
      <rect x="1.5" y="8.5" width="3" height="4" rx="0.8" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="5.5" y="5.5" width="3" height="7" rx="0.8" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="9.5" y="2.5" width="3" height="10" rx="0.8" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  );
}

// ─── Indicator card ───────────────────────────────────────────────────────────

function IndicatorCard({ item }: { item: DisplayItem }) {
  const changeColor = getChangeColor(item.label, item.displayLabel, item.direction);
  const isInverted  = item.label === "Yield Curve" && item.value.startsWith("-");
  const valueColor  = isInverted ? "text-red-400" : "text-white";

  return (
    <div className="flex items-start gap-2.5 py-3 sm:py-3.5 border-b border-white/[0.06] last:border-0">
      <div className="mt-[4px]">
        <IndicatorIcon label={item.displayLabel} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-semibold tracking-[0.12em] uppercase text-white/35 mb-1 truncate">
          {item.displayLabel}
        </p>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-[18px] font-bold leading-none tabular-nums ${valueColor}`}>
            {item.value}
          </span>
          {item.change && (
            <span className={`text-[11px] font-semibold flex items-center gap-0.5 tabular-nums leading-none ${changeColor}`}>
              <ArrowIcon direction={item.direction} />
              {item.change}
            </span>
          )}
        </div>
      </div>
      {item.sparkPoints && item.sparkPoints.length >= 2 && (
        <div className="mt-1 self-center">
          <Sparkline points={item.sparkPoints} direction={item.direction} />
        </div>
      )}
    </div>
  );
}

function IndicatorSkeleton() {
  return (
    <div className="flex items-start gap-2.5 py-3 border-b border-white/[0.06] last:border-0 animate-pulse">
      <div className="w-[11px] h-[11px] rounded bg-white/10 mt-1 shrink-0" />
      <div className="flex-1">
        <div className="h-2 bg-white/10 rounded w-16 mb-2.5" />
        <div className="h-4 bg-white/15 rounded w-20" />
      </div>
    </div>
  );
}

// ─── Section column ───────────────────────────────────────────────────────────

interface SectionProps {
  title:         string;
  type:          "market" | "rates" | "econ";
  items:         DisplayItem[];
  loading:       boolean;
  skeletonCount?: number;
  borderClass:   string;
}

function Section({ title, type, items, loading, skeletonCount = 4, borderClass }: SectionProps) {
  return (
    <div className={borderClass}>
      <div className="flex items-center gap-2 px-5 sm:px-6 lg:px-5 xl:px-6 pt-4 pb-1">
        <SectionIcon type={type} />
        <p className="text-[9px] font-bold tracking-[0.16em] uppercase text-white/40">
          {title}
        </p>
      </div>
      <div className="px-5 sm:px-6 lg:px-5 xl:px-6 pb-5">
        {loading
          ? Array.from({ length: skeletonCount }).map((_, i) => <IndicatorSkeleton key={i} />)
          : items.map((item) => <IndicatorCard key={item.label} item={item} />)
        }
      </div>
    </div>
  );
}

// ─── Signal tag row ───────────────────────────────────────────────────────────

function SignalTagRow({ tags }: { tags: SignalTag[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-3 flex flex-wrap gap-2">
      {tags.map((tag) => (
        <span
          key={tag.label}
          className={`inline-flex items-center px-2.5 py-1 rounded-md border text-[11px] font-semibold tracking-wide ${tag.colorClass}`}
        >
          {tag.label}
        </span>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MacroBoard() {
  const { snapshot, sparklines, loading: mktLoading } = useMarketData();
  const [macroData, setMacroData] = useState<MacroBoardData | null>(null);
  const [macroLoading, setMacroLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Fetch macro indicators (15-min Redis TTL — rates + economic data)
    fetch("/api/macro-board").then((r) => r.json()).catch(() => null).then((macro) => {
      if (cancelled) return;
      setMacroData(macro as MacroBoardData | null);
      setMacroLoading(false);
    });

    // Macro data refreshes on the same trading-hours cadence as market prices
    function scheduleMacroRefresh() {
      if (intervalRef.current) clearInterval(intervalRef.current);
      const intervalMs = getClientRefreshMs();
      intervalRef.current = setInterval(async () => {
        const res = await fetch("/api/macro-board").then((r) => r.json()).catch(() => null);
        if (res && !cancelled) {
          setMacroData(res as MacroBoardData);
          const newMs = getClientRefreshMs();
          if (newMs !== intervalMs) scheduleMacroRefresh();
        }
      }, intervalMs);
    }

    scheduleMacroRefresh();

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // ── Build MARKET PRICES — from shared context snapshot ────────────────────
  // Snapshot order: ["S&P 500", "VIX", "10Y Yield", "WTI Oil", "Gold", "USD Index", "BTC"]
  // We filter to SNAPSHOT_MKT items (excludes 10Y Yield — lives in Rates section)
  // and sort into MARKET_ORDER display order.

  // Build sparkline lookup map keyed by label (both raw and display label)
  const sparkMap: Record<string, number[]> = {};
  if (sparklines) {
    for (const s of sparklines.sparklines) sparkMap[s.label] = s.points;
  }

  const snapshotMktMap = new Map<string, DisplayItem>();
  for (const item of snapshot?.items ?? []) {
    if (!SNAPSHOT_MKT.has(item.label)) continue;
    const displayLabel = DISPLAY_LABEL[item.label] ?? item.label;
    // Sparklines keyed by display label (e.g. "Bitcoin", "Dollar Index") or raw label
    const points = sparkMap[displayLabel] ?? sparkMap[item.label];
    snapshotMktMap.set(item.label, {
      label:        item.label,
      displayLabel,
      value:        item.value,
      change:       item.change === "—" ? undefined : item.change,
      direction:    item.direction,
      source:       item.source,
      sparkPoints:  points,
    });
  }

  const marketPrices: DisplayItem[] = MARKET_ORDER
    .map((k) => snapshotMktMap.get(k))
    .filter(Boolean) as DisplayItem[];

  // ── Build RATES ──────────────────────────────────────────────────────────
  const rates: DisplayItem[] = macroData
    ? macroData.indicators
        .filter((i) => RATE_LABELS.has(i.label))
        .map((i) => ({
          label:        i.label,
          displayLabel: DISPLAY_LABEL[i.label] ?? i.label,
          value:        i.value,
          change:       i.change,
          direction:    i.direction,
          source:       i.source,
        }))
    : [];

  // ── Build ECONOMIC DATA ───────────────────────────────────────────────────
  const econData: DisplayItem[] = macroData
    ? macroData.indicators
        .filter((i) => ECON_LABELS.has(i.label))
        .map((i) => ({
          label:        i.label,
          displayLabel: DISPLAY_LABEL[i.label] ?? i.label,
          value:        i.value,
          change:       i.change,
          direction:    i.direction,
          source:       i.source,
        }))
    : [];

  // ── Combined loading state — show skeletons until BOTH sources have responded
  const loading = mktLoading || macroLoading;

  // ── Section visibility: show all skeletons while loading; hide empty after ─
  const ALL_SECTIONS = [
    { key: "market", title: "Market Prices", type: "market" as const, items: marketPrices, skeletonCount: 6 },
    { key: "rates",  title: "Rates",         type: "rates"  as const, items: rates,        skeletonCount: 4 },
    { key: "econ",   title: "Economic Data", type: "econ"   as const, items: econData,     skeletonCount: 4 },
  ];

  const visibleSections = loading
    ? ALL_SECTIONS
    : ALL_SECTIONS.filter((s) => s.items.length > 0);

  // Don't render the board at all if data loaded with nothing to show
  if (!loading && visibleSections.length === 0) return null;

  const colCount    = (loading ? 3 : visibleSections.length) as 1 | 2 | 3;
  const gridClass   = GRID_CLASS[colCount]   ?? GRID_CLASS[3];
  const borderClass = SECTION_BORDER[colCount] ?? SECTION_BORDER[3];

  // Build simple signal tags from live indicator data
  const signalTags = macroData ? buildSignalTags(macroData.indicators) : [];

  return (
    <div className="bg-navy-950 text-white border-t-2 border-white/[0.06]">
      <div className="mx-auto max-w-7xl">

        {/* Signal tags — 1-2 clear, data-backed tags when thresholds are crossed */}
        {!loading && <SignalTagRow tags={signalTags} />}

        {/* Indicator grid — only populated sections */}
        <div className={`grid ${gridClass} border-t border-white/[0.07]`}>
          {(loading ? ALL_SECTIONS : visibleSections).map((section) => (
            <Section
              key={section.key}
              title={section.title}
              type={section.type}
              items={section.items}
              loading={loading}
              skeletonCount={section.skeletonCount}
              borderClass={borderClass}
            />
          ))}
        </div>

        {/* Data sources footer */}
        <div className="px-4 sm:px-6 lg:px-8 py-2.5 border-t border-white/[0.05]">
          <p className="text-[9px] text-white/20 text-right tracking-wide">
            Data sources: Federal Reserve (FRED), Bureau of Labor Statistics, TwelveData, EIA
          </p>
        </div>

      </div>
    </div>
  );
}
