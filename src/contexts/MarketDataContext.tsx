"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { MarketSnapshotData, MarketSparklinesData } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// Context value shape
// ---------------------------------------------------------------------------

interface MarketDataContextValue {
  snapshot:   MarketSnapshotData | null;
  sparklines: MarketSparklinesData | null;
  loading:    boolean;
}

const MarketDataContext = createContext<MarketDataContextValue>({
  snapshot:   null,
  sparklines: null,
  loading:    true,
});

// ---------------------------------------------------------------------------
// Session-aware refresh interval (ET, DST-safe)
// Market open (9:30–4 ET, Mon–Fri): 60s
// All other times (extended hours, weekend, overnight): 5 min — BTC trades 24/7
// ---------------------------------------------------------------------------

function getRefreshMs(): number {
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const day = etNow.getDay();
  const tm  = etNow.getHours() * 60 + etNow.getMinutes();
  if (day >= 1 && day <= 5 && tm >= 9 * 60 + 30 && tm < 16 * 60) return 60_000;
  return 5 * 60_000;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function MarketDataProvider({ children }: { children: React.ReactNode }) {
  const [snapshot,   setSnapshot]   = useState<MarketSnapshotData | null>(null);
  const [sparklines, setSparklines] = useState<MarketSparklinesData | null>(null);
  const [loading,    setLoading]    = useState(true);

  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const sparkRefreshAt = useRef<number>(Date.now() + 15 * 60_000);

  useEffect(() => {
    let cancelled = false;

    // Initial load — fetch snapshot and sparklines in parallel
    Promise.all([
      fetch("/api/market-snapshot", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => null),
      fetch("/api/market-sparklines", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => null),
    ]).then(([snap, sparks]) => {
      if (cancelled) return;
      if (snap?.items?.length > 0) setSnapshot(snap as MarketSnapshotData);
      if (sparks?.sparklines)      setSparklines(sparks as MarketSparklinesData);
      setLoading(false);
    });

    // Polling — single loop manages both snapshot (frequent) and sparklines (15-min)
    function scheduleRefresh() {
      if (intervalRef.current) clearInterval(intervalRef.current);
      const intervalMs = getRefreshMs();

      intervalRef.current = setInterval(async () => {
        if (cancelled) return;

        // Always refresh snapshot (price changes every 60s or 5min)
        const snapRes = await fetch("/api/market-snapshot", { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => null);

        if (!cancelled && snapRes?.items?.length > 0) {
          setSnapshot(snapRes as MarketSnapshotData);
        }

        // Refresh sparklines only when their 15-min TTL has elapsed
        if (Date.now() >= sparkRefreshAt.current) {
          const sparksRes = await fetch("/api/market-sparklines", { cache: "no-store" })
            .then((r) => r.json())
            .catch(() => null);

          if (!cancelled && sparksRes?.sparklines) {
            setSparklines(sparksRes as MarketSparklinesData);
          }
          sparkRefreshAt.current = Date.now() + 15 * 60_000;
        }

        // Re-schedule if the trading session changed (e.g., market just opened/closed)
        if (getRefreshMs() !== intervalMs) scheduleRefresh();
      }, intervalMs);
    }

    scheduleRefresh();

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <MarketDataContext.Provider value={{ snapshot, sparklines, loading }}>
      {children}
    </MarketDataContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMarketData(): MarketDataContextValue {
  return useContext(MarketDataContext);
}
