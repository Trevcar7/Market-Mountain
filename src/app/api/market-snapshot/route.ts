import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MarketSnapshotData, MarketSnapshotItem } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-snapshot";
const CACHE_SECONDS = 60; // 60-second strip TTL — near-live

/**
 * GET /api/market-snapshot
 * Returns six core market indicators for the homepage strip:
 *   S&P 500, 10Y Yield, WTI Oil, Bitcoin, VIX, Dollar Index
 *
 * Data sources (graceful-degrade, all parallel):
 *   - FRED: S&P 500 (SP500), VIX (VIXCLS), 10Y yield (DGS10) — daily close
 *   - EIA:  WTI crude oil
 *   - TwelveData (TWELVEDATA_API_KEY): DXY, BTC/USD — real-time
 *   - FMP   (FMP_API_KEY, fallback):   DXY, BTC + overrides S&P 500/VIX with intraday
 *
 * TTL: 60 seconds (strip refreshes every minute on the client during weekdays)
 */
export async function GET() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    const data = await buildSnapshot();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
    });
  }

  try {
    const kv = new Redis({ url, token });

    const cached = await kv.get<MarketSnapshotData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
      });
    }

    const data = await buildSnapshot();
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
    });
  } catch (error) {
    console.error("[/api/market-snapshot] Error:", error);
    const fallback = await buildSnapshot().catch(() => emptySnapshot());
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Snapshot builder — collects data from multiple sources in parallel
// ---------------------------------------------------------------------------

async function buildSnapshot(): Promise<MarketSnapshotData> {
  const now = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  // Fetch FRED + EIA in parallel — all gracefully degrade on key absence / failure
  // fetchFredSeries returns desc-sorted observations ([0] = most recent, "." already filtered)
  const [sp500Res, vixRes, tenYearRes, wtiRes] = await Promise.allSettled([
    fetchFredSeries("SP500",  3),   // S&P 500 composite (daily close, 1-day delayed)
    fetchFredSeries("VIXCLS", 3),   // CBOE VIX (daily close, 1-day delayed)
    fetchFredSeries("DGS10",  3),   // 10-Year Treasury yield
    fetchWtiCrudePrice(),           // WTI crude oil spot price
  ]);

  // Use a Map so TwelveData/FMP can override FRED values where they have real-time data
  const itemMap = new Map<string, MarketSnapshotItem>();

  // ── S&P 500 (FRED baseline — overridden by FMP if FMP key set) ────────────
  const sp500Obs = sp500Res.status === "fulfilled" ? sp500Res.value : [];
  if (sp500Obs.length >= 1) {
    const latest = parseFloat(sp500Obs[0].value);
    const prev   = sp500Obs.length >= 2 ? parseFloat(sp500Obs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("S&P 500", {
        label:     "S&P 500",
        value:     Math.round(latest).toLocaleString(),
        change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.01 ? "up" : pct < -0.01 ? "down" : "flat",
        source:    "FRED",
      });
    }
  }

  // ── VIX (FRED baseline — overridden by FMP if FMP key set) ───────────────
  const vixObs = vixRes.status === "fulfilled" ? vixRes.value : [];
  if (vixObs.length >= 1) {
    const latest = parseFloat(vixObs[0].value);
    const prev   = vixObs.length >= 2 ? parseFloat(vixObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const change = !isNaN(prev) ? latest - prev : 0;
      itemMap.set("VIX", {
        label:     "VIX",
        value:     latest.toFixed(2),
        change:    Math.abs(change) < 0.005 ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}`,
        direction: change > 0.01 ? "up" : change < -0.01 ? "down" : "flat",
        source:    "FRED",
      });
    }
  }

  // ── 10Y Treasury Yield (FRED) ─────────────────────────────────────────────
  const tenObs = tenYearRes.status === "fulfilled" ? tenYearRes.value : [];
  if (tenObs.length >= 1) {
    const latest = parseFloat(tenObs[0].value);
    const prev   = tenObs.length >= 2 ? parseFloat(tenObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const changeBps = !isNaN(prev) ? Math.round((latest - prev) * 100) : 0;
      itemMap.set("10Y Yield", {
        label:     "10Y Yield",
        value:     `${latest.toFixed(2)}%`,
        change:    changeBps === 0 ? "—" : `${changeBps > 0 ? "+" : ""}${changeBps}bps`,
        direction: changeBps > 0 ? "up" : changeBps < 0 ? "down" : "flat",
        source:    "FRED",
      });
    }
  }

  // ── WTI Crude Oil (EIA) ────────────────────────────────────────────────────
  if (wtiRes.status === "fulfilled" && wtiRes.value && typeof wtiRes.value.value === "number") {
    itemMap.set("WTI Oil", {
      label:     "WTI Oil",
      value:     `$${wtiRes.value.value.toFixed(2)}`,
      change:    "—",
      direction: "flat",
      source:    "EIA",
    });
  }

  // ── TwelveData: DXY + BTC (real-time) — S&P 500 + VIX come from FRED above ─
  // FMP fallback also re-fetches S&P 500 + VIX with intraday data (overrides FRED)
  const twKey  = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;
  if (twKey) {
    for (const item of await fetchTwelveDataSnapshot(twKey)) {
      itemMap.set(item.label, item);
    }
  } else if (fmpKey) {
    for (const item of await fetchFmpSnapshot(fmpKey)) {
      itemMap.set(item.label, item);  // FMP overrides FRED baseline for S&P 500, VIX
    }
  }

  // ── Output in preferred strip order ──────────────────────────────────────
  const STRIP_ORDER = ["S&P 500", "10Y Yield", "WTI Oil", "BTC", "VIX", "DXY"];
  const items = STRIP_ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  return {
    items: items.slice(0, 6),
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData — equity/volatility/FX/crypto data (preferred source)
// ---------------------------------------------------------------------------

interface TwelveDataQuote {
  symbol?: string;
  close?: string;
  percent_change?: string;
  // Present on per-symbol errors
  code?: number;
  message?: string;
}

async function fetchTwelveDataSnapshot(apiKey: string): Promise<MarketSnapshotItem[]> {
  // Dollar Index (DXY) + Bitcoin (BTC/USD) — real-time on TwelveData free plan
  // S&P 500 and VIX are fetched from FRED (indices require TwelveData paid plan)
  const labelMap: Record<string, string> = {
    "DXY":     "DXY",
    "BTC/USD": "BTC",
  };

  try {
    const url = `https://api.twelvedata.com/quote?symbol=DXY,BTC/USD&apikey=${apiKey}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 60 },
    });
    if (!res.ok) {
      console.warn(`[market-snapshot/TwelveData] HTTP ${res.status}`);
      return [];
    }

    const raw = (await res.json()) as Record<string, TwelveDataQuote>;
    const result: MarketSnapshotItem[] = [];

    for (const [sym, quote] of Object.entries(raw)) {
      // Per-symbol errors return { code, message } instead of quote data
      if (!quote || quote.code || !quote.close) {
        if (quote?.code) console.warn(`[market-snapshot/TwelveData] ${sym}: ${quote.message}`);
        continue;
      }

      const price = parseFloat(quote.close);
      if (isNaN(price)) continue;

      const pct = parseFloat(quote.percent_change ?? "0");
      const label = labelMap[sym];
      if (!label) continue;

      let value: string;
      if (sym === "BTC/USD") value = `$${Math.round(price).toLocaleString()}`;
      else                   value = price.toFixed(2); // DXY

      result.push({
        label,
        value,
        change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
        source: "Twelve Data",
      });
    }

    return result;
  } catch (err) {
    console.error("[market-snapshot/TwelveData] fetch error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// FMP (Financial Modeling Prep) — equity/volatility/crypto data (fallback)
// ---------------------------------------------------------------------------

interface FmpQuote {
  symbol: string;
  price: number;
  changesPercentage: number;
}

async function fetchFmpSnapshot(apiKey: string): Promise<MarketSnapshotItem[]> {
  const symbols = ["^GSPC", "^VIX", "DX-Y.NYB", "BTCUSD"];
  const labels: Record<string, string> = {
    "^GSPC": "S&P 500",
    "^VIX":  "VIX",
    "DX-Y.NYB": "DXY",
    "BTCUSD": "BTC",
  };

  try {
    const url = `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${apiKey}`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return [];

    const quotes = (await res.json()) as FmpQuote[];
    return quotes.map((q) => {
      const pct = q.changesPercentage ?? 0;
      const pctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      const label = labels[q.symbol] ?? q.symbol;

      // Format value based on asset
      let valueStr: string;
      if (q.symbol === "^VIX") {
        valueStr = q.price.toFixed(2);
      } else if (q.symbol === "BTCUSD") {
        valueStr = `$${Math.round(q.price).toLocaleString()}`;
      } else if (q.symbol === "^GSPC") {
        valueStr = q.price.toFixed(0);
      } else {
        valueStr = q.price.toFixed(2);
      }

      return {
        label,
        value: valueStr,
        change: pctStr,
        direction: (pct > 0 ? "up" : pct < 0 ? "down" : "flat") as "up" | "down" | "flat",
        source: "FMP",
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Empty fallback
// ---------------------------------------------------------------------------

function emptySnapshot(): MarketSnapshotData {
  return {
    items: [],
    generatedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}
