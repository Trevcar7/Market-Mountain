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
// Refresh interval — 5 minutes
// Server-side caches (KV + CDN) use 5-min TTL, so polling faster would
// only return cached data. Consistent 5-min interval across all sessions.
// ---------------------------------------------------------------------------

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function MarketDataProvider({ children }: { children: React.ReactNode }) {
  const [snapshot,   setSnapshot]   = useState<MarketSnapshotData | null>(null);
  const [sparklines, setSparklines] = useState<MarketSparklinesData | null>(null);
  const [loading,    setLoading]    = useState(true);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

    // Polling — refresh both snapshot and sparklines every 5 minutes
    intervalRef.current = setInterval(async () => {
      if (cancelled) return;

      const [snapRes, sparksRes] = await Promise.all([
        fetch("/api/market-snapshot", { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => null),
        fetch("/api/market-sparklines", { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => null),
      ]);

      if (!cancelled && snapRes?.items?.length > 0) {
        setSnapshot(snapRes as MarketSnapshotData);
      }
      if (!cancelled && sparksRes?.sparklines) {
        setSparklines(sparksRes as MarketSparklinesData);
      }
    }, REFRESH_MS);

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
