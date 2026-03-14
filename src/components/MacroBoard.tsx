"use client";

import { useEffect, useState } from "react";
import { MacroBoardData, MarketSnapshotData, RegimeDimensions } from "@/lib/news-types";

// ─── Display config ───────────────────────────────────────────────────────────

const DISPLAY_LABEL: Record<string, string> = {
  "10-Year Yield": "10Y Treasury",
  "2-Year Yield":  "2Y Treasury",
  "Yield Curve":   "Yield Curve (10Y–2Y)",
  Unemployment:    "Unemployment Rate",
  "WTI Crude":     "WTI Oil",
  DXY:             "Dollar Index",
  BTC:             "Bitcoin",
};

// Labels fetched from snapshot that belong in MARKET PRICES
const SNAPSHOT_MKT = new Set(["S&P 500", "VIX", "DXY", "BTC"]);

// Labels from macro-board that belong in each section
const RATE_LABELS = new Set(["Fed Funds Rate", "10-Year Yield", "2-Year Yield", "Yield Curve"]);
const ECON_LABELS = new Set(["CPI (YoY)", "Core CPI (YoY)", "Unemployment", "Nonfarm Payrolls"]);

// Preferred display order for MARKET PRICES
const MKT_ORDER = ["S&P 500", "VIX", "WTI Oil", "Dollar Index", "Bitcoin"];

// Labels where direction UP = bullish / green
const POSITIVE_UP = new Set(["S&P 500", "Nonfarm Payrolls", "Bitcoin"]);

// Labels where direction UP = bearish / red
const NEGATIVE_UP = new Set([
  "Fed Funds Rate", "10Y Treasury", "10-Year Yield",
  "2Y Treasury", "2-Year Yield",
  "VIX", "CPI (YoY)", "Core CPI (YoY)",
]);

interface DisplayItem {
  label:        string;
  displayLabel: string;
  value:        string;
  change?:      string;
  direction:    "up" | "down" | "flat";
  source:       string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getChangeColor(label: string, displayLabel: string, direction: "up" | "down" | "flat"): string {
  if (direction === "flat") return "text-white/35";
  if (label === "Yield Curve")
    return direction === "up" ? "text-emerald-400" : "text-red-400";
  if (POSITIVE_UP.has(label) || POSITIVE_UP.has(displayLabel))
    return direction === "up" ? "text-emerald-400" : "text-red-400";
  if (NEGATIVE_UP.has(label) || NEGATIVE_UP.has(displayLabel))
    return direction === "up" ? "text-red-400" : "text-emerald-400";
  // WTI Oil — up = inflationary pressure (amber warning)
  if (label.includes("Oil") || label.includes("WTI"))
    return direction === "up" ? "text-amber-400" : "text-emerald-400";
  // DXY — neutral green/red
  return direction === "up" ? "text-emerald-400" : "text-red-400";
}

function parseDimensionsFromTags(tags: string[]): RegimeDimensions {
  const d: RegimeDimensions = { inflation: "—", policy: "—", growth: "—", liquidity: "—" };
  for (const tag of tags) {
    if (tag.includes("Policy Restrictive"))  d.policy = "Restrictive";
    if (tag.includes("Policy Accommod"))    d.policy = "Accommodative";
    if (tag.includes("Policy Easing"))      d.policy = "Easing";
    if (tag.includes("Policy Tightening"))  d.policy = "Tightening";
    if (tag.includes("Inflation Persistent")) d.inflation = "Persistent";
    if (tag.includes("Above-Target"))       d.inflation = "Above Target";
    if (tag.includes("Disinflation"))       d.inflation = "Disinflating";
    if (tag.includes("Near Target"))        d.inflation = "Near Target";
    if (tag.includes("Labor Market Tight")) d.growth = "Solid";
    if (tag.includes("Labor Market Cool"))  d.growth = "Slowing";
    if (tag.includes("Yield Curve Inverted")) d.liquidity = "Tightening";
    if (tag.includes("Curve Flattening"))   d.liquidity = "Tight";
  }
  return d;
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
  if (label.includes("Dollar") || label === "DXY") return (
    <svg viewBox="0 0 12 12" fill="none" className={cls} aria-hidden="true">
      <path d="M6 1.5V10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M3.5 4C3.5 3.2 4.7 2.5 6 2.5C7.3 2.5 8.5 3.2 8.5 4C8.5 5 7 5.5 6 5.5C4.8 5.5 3.5 6 3.5 7C3.5 7.8 4.7 8.5 6 8.5C7.3 8.5 8.5 7.8 8.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
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
      {/* Icon */}
      <div className="mt-[4px]">
        <IndicatorIcon label={item.displayLabel} />
      </div>

      {/* Data */}
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-semibold tracking-[0.12em] uppercase text-white/35 mb-1 truncate">
          {item.displayLabel}
        </p>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-[15px] font-bold leading-none tabular-nums ${valueColor}`}>
            {item.value}
          </span>
          {item.change && (
            <span className={`text-[10px] font-semibold flex items-center gap-0.5 tabular-nums leading-none ${changeColor}`}>
              <ArrowIcon direction={item.direction} />
              {item.change}
            </span>
          )}
        </div>
        <p className="text-[9px] text-white/20 mt-1.5 tabular-nums">Source: {item.source}</p>
      </div>
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
  title: string;
  type: "market" | "rates" | "econ";
  items: DisplayItem[];
  loading: boolean;
  skeletonCount?: number;
}

function Section({ title, type, items, loading, skeletonCount = 4 }: SectionProps) {
  return (
    <div className="border-b lg:border-b-0 lg:border-r border-white/[0.07] last:border-0">
      {/* Section header */}
      <div className="flex items-center gap-2 px-5 sm:px-6 lg:px-5 xl:px-6 pt-4 pb-1">
        <SectionIcon type={type} />
        <p className="text-[9px] font-bold tracking-[0.16em] uppercase text-white/40">
          {title}
        </p>
      </div>

      {/* Indicators */}
      <div className="px-5 sm:px-6 lg:px-5 xl:px-6 pb-5">
        {loading
          ? Array.from({ length: skeletonCount }).map((_, i) => <IndicatorSkeleton key={i} />)
          : items.length === 0
          ? <p className="text-white/20 text-xs py-4">Data unavailable</p>
          : items.map((item) => <IndicatorCard key={item.label} item={item} />)
        }
      </div>
    </div>
  );
}

// ─── Regime panel ─────────────────────────────────────────────────────────────

function dimensionColor(dim: string, value: string): string {
  const v = value.toLowerCase();
  if (dim === "inflation") {
    if (v.includes("persistent"))               return "bg-red-500/20 text-red-300 border-red-500/20";
    if (v.includes("above"))                    return "bg-amber-500/20 text-amber-300 border-amber-500/20";
    if (v.includes("disinflat") || v.includes("near")) return "bg-emerald-500/20 text-emerald-300 border-emerald-500/20";
  }
  if (dim === "policy") {
    if (v.includes("restrict") || v.includes("tighten")) return "bg-red-500/20 text-red-300 border-red-500/20";
    if (v.includes("easing") || v.includes("accommod")) return "bg-emerald-500/20 text-emerald-300 border-emerald-500/20";
    if (v.includes("neutral"))                  return "bg-white/10 text-white/45 border-white/10";
  }
  if (dim === "growth") {
    if (v.includes("solid"))                    return "bg-emerald-500/20 text-emerald-300 border-emerald-500/20";
    if (v.includes("moderat"))                  return "bg-amber-500/20 text-amber-300 border-amber-500/20";
    if (v.includes("slow"))                     return "bg-red-500/20 text-red-300 border-red-500/20";
  }
  if (dim === "liquidity") {
    if (v.includes("tighten") || v === "tight") return "bg-red-500/20 text-red-300 border-red-500/20";
    if (v.includes("neutral"))                  return "bg-amber-500/20 text-amber-300 border-amber-500/20";
    if (v.includes("easing") || v.includes("accommod")) return "bg-emerald-500/20 text-emerald-300 border-emerald-500/20";
  }
  return "bg-white/10 text-white/40 border-white/10";
}

const REGIME_ENTRIES = [
  { key: "inflation", label: "Inflation" },
  { key: "policy",    label: "Policy" },
  { key: "growth",    label: "Growth" },
  { key: "liquidity", label: "Liquidity" },
] as const;

function RegimePanel({ dimensions }: { dimensions: RegimeDimensions }) {
  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-5 pb-4">
      <p className="text-[9px] font-bold tracking-[0.16em] uppercase text-white/30 mb-3">
        Current Macro Regime
      </p>
      <div className="flex flex-wrap gap-2">
        {REGIME_ENTRIES.map(({ key, label }) => {
          const value = dimensions[key];
          if (!value || value === "—") return null;
          const colorClass = dimensionColor(key, value);
          return (
            <div
              key={key}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium ${colorClass}`}
            >
              <span className="opacity-60 font-normal">{label}:</span>
              <span className="font-semibold">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RegimeSkeleton() {
  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-5 pb-4 animate-pulse">
      <div className="h-2 bg-white/10 rounded w-28 mb-3" />
      <div className="flex gap-2">
        {[80, 72, 60, 76].map((w, i) => (
          <div key={i} className="h-7 bg-white/8 rounded-lg border border-white/10" style={{ width: w }} />
        ))}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MacroBoard() {
  const [macroData,    setMacroData]    = useState<MacroBoardData | null>(null);
  const [snapshotData, setSnapshotData] = useState<MarketSnapshotData | null>(null);
  const [loading,      setLoading]      = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/macro-board").then((r) => r.json()).catch(() => null),
      fetch("/api/market-snapshot").then((r) => r.json()).catch(() => null),
    ]).then(([macro, snap]) => {
      if (cancelled) return;
      setMacroData(macro as MacroBoardData | null);
      setSnapshotData(snap as MarketSnapshotData | null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Build MARKET PRICES (snapshot items + WTI from macro-board) ─────────────
  const mktRaw: Record<string, DisplayItem> = {};

  if (snapshotData) {
    for (const item of snapshotData.items) {
      if (!SNAPSHOT_MKT.has(item.label)) continue;
      const dl = DISPLAY_LABEL[item.label] ?? item.label;
      mktRaw[dl] = {
        label:        item.label,
        displayLabel: dl,
        value:        item.value,
        change:       item.change === "—" ? undefined : item.change,
        direction:    item.direction,
        source:       item.source,
      };
    }
  }

  if (macroData) {
    const wti = macroData.indicators.find((i) => i.label === "WTI Crude");
    if (wti) {
      mktRaw["WTI Oil"] = {
        label:        wti.label,
        displayLabel: "WTI Oil",
        value:        wti.value,
        change:       wti.change,
        direction:    wti.direction,
        source:       wti.source,
      };
    }
  }

  const marketPrices: DisplayItem[] = MKT_ORDER.map((l) => mktRaw[l]).filter(Boolean) as DisplayItem[];

  // ── Build RATES ──────────────────────────────────────────────────────────────
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

  // ── Build ECONOMIC DATA ───────────────────────────────────────────────────────
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

  // Don't render if data loaded but completely empty
  if (!loading && marketPrices.length === 0 && rates.length === 0 && econData.length === 0) return null;

  // Resolve regime dimensions
  const dims: RegimeDimensions | null = macroData?.regimeDimensions
    ?? (macroData?.regimeTags?.length
        ? parseDimensionsFromTags(macroData.regimeTags)
        : null);

  return (
    <div className="bg-navy-950 text-white border-t-2 border-white/[0.04]">
      <div className="mx-auto max-w-7xl">

        {/* Regime panel */}
        {loading
          ? <RegimeSkeleton />
          : dims && <RegimePanel dimensions={dims} />
        }

        {/* Three-section indicator grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 border-t border-white/[0.07]">
          <Section
            title="Market Prices"
            type="market"
            items={marketPrices}
            loading={loading}
            skeletonCount={5}
          />
          <Section
            title="Rates"
            type="rates"
            items={rates}
            loading={loading}
            skeletonCount={4}
          />
          <Section
            title="Economic Data"
            type="econ"
            items={econData}
            loading={loading}
            skeletonCount={4}
          />
        </div>

      </div>
    </div>
  );
}
