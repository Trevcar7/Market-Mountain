import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { MarketSnapshotData, MarketSnapshotItem } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-snapshot";
const CACHE_SECONDS = 5 * 60; // 5 minutes

/**
 * GET /api/market-snapshot
 * Returns six core market indicators for the homepage strip + MacroBoard:
 *   S&P 500, VIX, 10Y Yield, WTI Oil, DXY, BTC
 *
 * Data source strategy (priority order):
 *   1. Yahoo Finance — same-day quote data (no key required).
 *   2. FRED — daily-close fallback (can lag 1 day on business days).
 *   3. TwelveData — BTC/USD (crypto, real-time on free tier).
 *
 * All independent sources are fetched in parallel (fan-out / fan-in).
 * Items are filled in priority order: Yahoo > FRED, with 10Y always from FRED.
 *
 * TTL: 5-min server-side Redis cache.
 * Pass ?_debug=<SNAPSHOT_DEBUG_KEY> for diagnostic info.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const debugParam = url.searchParams.get("_debug");
  const debugSecret = process.env.SNAPSHOT_DEBUG_KEY;
  // Debug requires a secret to prevent cache bypass abuse and info leakage
  const debug = !!(debugParam && debugSecret && debugParam === debugSecret);

  const kv = getRedisClient();

  if (!kv) {
    const data = await buildSnapshot(debug);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  }

  try {
    // Skip cache for debug requests
    if (!debug) {
      const cached = await kv.get<MarketSnapshotData>(KV_KEY);
      if (cached && new Date(cached.validUntil) > new Date()) {
        return NextResponse.json(cached, {
          headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
        });
      }
    }

    const data = await buildSnapshot(debug);

    // Only cache non-debug requests with meaningful data (>=3 items).
    if (data.items.length >= 3 && !debug) {
      await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });
    } else if (data.items.length < 3) {
      console.warn(`[/api/market-snapshot] Only ${data.items.length} items resolved — skipping cache`);
    }

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (error) {
    console.error("[/api/market-snapshot] Error:", error);
    const fallback = await buildSnapshot(false).catch(() => emptySnapshot());
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Indicator config — single source of truth for formatting & thresholds
// ---------------------------------------------------------------------------

interface IndicatorConfig {
  formatValue: (price: number) => string;
  /** "pct" = percentage change, "abs" = absolute points (VIX), "bps" = basis points (yields) */
  changeType: "pct" | "abs";
  threshold: number;
}

const INDICATOR_CONFIGS: Record<string, IndicatorConfig> = {
  "S&P 500": { formatValue: (p) => Math.round(p).toLocaleString(),  changeType: "pct", threshold: 0.01 },
  "VIX":     { formatValue: (p) => p.toFixed(2),                    changeType: "abs", threshold: 0.005 },
  "DXY":     { formatValue: (p) => p.toFixed(2),                    changeType: "pct", threshold: 0.005 },
  "WTI Oil": { formatValue: (p) => `$${p.toFixed(2)}`,              changeType: "pct", threshold: 0.005 },
  "BTC":     { formatValue: (p) => `$${Math.round(p).toLocaleString()}`, changeType: "pct", threshold: 0.005 },
};

/** Build a MarketSnapshotItem using the config for the given key. */
function buildItem(
  key: string,
  price: number,
  pctChange: number,
  absChange: number,
  source: string,
): MarketSnapshotItem {
  const cfg = INDICATOR_CONFIGS[key];
  if (!cfg) {
    // Fallback for unconfigured keys (e.g., 10Y Yield handled separately)
    return { label: key, value: String(price), change: "—", direction: "flat", source };
  }
  const changeVal = cfg.changeType === "abs" ? absChange : pctChange;
  const suffix = cfg.changeType === "pct" ? "%" : "";

  return {
    label:     key,
    value:     cfg.formatValue(price),
    change:    Math.abs(changeVal) < cfg.threshold ? "—" : `${changeVal >= 0 ? "+" : ""}${changeVal.toFixed(2)}${suffix}`,
    direction: changeVal > cfg.threshold ? "up" : changeVal < -cfg.threshold ? "down" : "flat",
    source,
  };
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

async function buildSnapshot(debug = false): Promise<MarketSnapshotData> {
  const now        = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);
  const twKey      = process.env.TWELVEDATA_API_KEY;
  const debugLog: string[] | null = debug ? [] : null;

  const itemMap = new Map<string, MarketSnapshotItem>();

  if (debugLog) {
    debugLog.push(`TWELVEDATA_API_KEY: ${twKey ? `set (${twKey.length} chars)` : "NOT SET"}`);
    debugLog.push(`FRED_API_KEY: ${process.env.FRED_API_KEY ? "set" : "NOT SET"}`);
  }

  // ── Fan-out: launch ALL independent fetches in parallel ─────────────────
  // Yahoo: S&P 500, VIX, DXY, WTI Oil (same-day quotes)
  // FRED:  10Y Yield (always), S&P/VIX/WTI (fallback if Yahoo fails)
  // TwelveData: BTC/USD
  const yahooSymbols = [
    { symbol: "^GSPC",    key: "S&P 500" },
    { symbol: "^VIX",     key: "VIX" },
    { symbol: "DX-Y.NYB", key: "DXY" },
    { symbol: "CL=F",     key: "WTI Oil" },
  ] as const;

  const [
    // Yahoo results (indices 0-3)
    ...allResults
  ] = await Promise.allSettled([
    ...yahooSymbols.map(({ symbol }) => fetchYahooQuote(symbol)),
    // FRED results (indices 4-8)
    fetchFredSeries("SP500",      3),          // [4] S&P fallback
    fetchFredSeries("VIXCLS",     3),          // [5] VIX fallback
    fetchFredSeries("DGS10",      3),          // [6] 10Y (always)
    fetchWtiCrudePrice(),                      // [7] WTI EIA
    fetchFredSeries("DCOILWTICO", 3),          // [8] WTI FRED fallback
    // TwelveData (index 9)
    twKey ? fetchTwelveDataQuote(twKey, "BTC/USD") : Promise.resolve(null), // [9]
  ]);

  // ── Process Yahoo results (primary source) ──────────────────────────────
  for (let i = 0; i < yahooSymbols.length; i++) {
    const result = allResults[i];
    if (result.status !== "fulfilled" || !result.value) {
      if (debugLog) debugLog.push(`Yahoo ${yahooSymbols[i].symbol}: ${result.status === "rejected" ? String((result as PromiseRejectedResult).reason) : "null"}`);
      continue;
    }
    const yq = result.value as YahooQuoteResult;
    const { key } = yahooSymbols[i];

    itemMap.set(key, buildItem(key, yq.price, yq.pctChange, yq.absChange, "Yahoo"));

    console.log(`[market-snapshot] Yahoo ${key}: ${yq.price}`);
    debugLog?.push(`Yahoo ${key}: ${yq.price} (${yq.pctChange >= 0 ? "+" : ""}${yq.pctChange.toFixed(2)}%)`);
  }

  // ── Process FRED fallbacks (fills gaps Yahoo didn't cover) ──────────────
  type FredObs = { date: string; value: string }[];

  const sp500Obs   = allResults[4].status === "fulfilled" ? allResults[4].value as FredObs : [];
  const vixObs     = allResults[5].status === "fulfilled" ? allResults[5].value as FredObs : [];
  const tenYearObs = allResults[6].status === "fulfilled" ? allResults[6].value as FredObs : [];
  const wtiEiaVal  = allResults[7].status === "fulfilled" ? allResults[7].value as { value: number; period: string } | null : null;
  const wtiCoObs   = allResults[8].status === "fulfilled" ? allResults[8].value as FredObs : [];

  // S&P 500 fallback
  if (!itemMap.has("S&P 500") && sp500Obs.length >= 1) {
    const latest = parseFloat(sp500Obs[0].value);
    const prev   = sp500Obs.length >= 2 ? parseFloat(sp500Obs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("S&P 500", buildItem("S&P 500", latest, pct, latest - (prev || latest), "FRED"));
    }
  }

  // VIX fallback
  if (!itemMap.has("VIX") && vixObs.length >= 1) {
    const latest = parseFloat(vixObs[0].value);
    const prev   = vixObs.length >= 2 ? parseFloat(vixObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pts = !isNaN(prev) ? latest - prev : 0;
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("VIX", buildItem("VIX", latest, pct, pts, "FRED"));
    }
  }

  // 10Y Treasury Yield — always from FRED, change in basis points
  if (tenYearObs.length >= 1) {
    const latest = parseFloat(tenYearObs[0].value);
    const prev   = tenYearObs.length >= 2 ? parseFloat(tenYearObs[1].value) : NaN;
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

  // WTI Crude Oil fallback — EIA primary, FRED secondary
  if (!itemMap.has("WTI Oil")) {
    if (wtiEiaVal?.value != null) {
      itemMap.set("WTI Oil", {
        label: "WTI Oil", value: `$${wtiEiaVal.value.toFixed(2)}`,
        change: "—", direction: "flat", source: "EIA",
      });
    } else if (wtiCoObs.length >= 1) {
      const latest = parseFloat(wtiCoObs[0].value);
      const prev   = wtiCoObs.length >= 2 ? parseFloat(wtiCoObs[1].value) : NaN;
      if (!isNaN(latest)) {
        const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
        itemMap.set("WTI Oil", buildItem("WTI Oil", latest, pct, latest - (prev || latest), "FRED"));
      }
    }
  }

  // DXY: NO FRED fallback — FRED DTWEXBGS is the Trade-Weighted Broad Dollar
  // Index (~120), NOT the ICE DXY (~99). DXY only appears via Yahoo.

  // ── Process TwelveData BTC ──────────────────────────────────────────────
  const btcResult = allResults[9];
  if (btcResult.status === "fulfilled" && btcResult.value) {
    const btc = btcResult.value as TwelveDataRaw;
    itemMap.set("BTC", buildItem("BTC", btc.price, btc.pctChange, btc.absChange, "TwelveData"));
  }

  // ── Output in display order ────────────────────────────────────────────
  const STRIP_ORDER = ["S&P 500", "VIX", "10Y Yield", "WTI Oil", "DXY", "BTC"];
  const items = STRIP_ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  const result: MarketSnapshotData & { _debug?: string[] } = {
    items: items.slice(0, 7),
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };

  if (debugLog) {
    result._debug = debugLog;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Yahoo Finance — unofficial quote API (no key required)
// ---------------------------------------------------------------------------

interface YahooQuoteResult {
  price:     number;
  pctChange: number;
  absChange: number;
}

interface YahooV8Response {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: (number | null)[];
        }>;
      };
    }>;
    error?: { description?: string };
  };
}

/**
 * Fetch a quote from Yahoo Finance's v8 chart endpoint.
 * No API key needed. Returns same-day market close data.
 * Falls back gracefully if Yahoo blocks the request.
 */
async function fetchYahooQuote(symbol: string): Promise<YahooQuoteResult | null> {
  try {
    const encoded = encodeURIComponent(symbol);
    // range=5d ensures we always have at least one previous trading day
    // (handles weekends/holidays)
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`,
      {
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MarketMountain/1.0)",
          "Accept": "application/json",
        },
      }
    );

    if (!res.ok) {
      console.warn(`[market-snapshot/Yahoo] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as YahooV8Response;
    const result = data.chart?.result?.[0];
    if (!result) {
      console.warn(`[market-snapshot/Yahoo] ${symbol}: no chart result`);
      return null;
    }

    // Get current price from meta
    const price = result.meta?.regularMarketPrice;
    if (!price || price <= 0) return null;

    // Compute previous close from chart data (most reliable method):
    // The chart returns daily closes for range=5d. The second-to-last
    // non-null close is yesterday's close, giving us the true daily change.
    let prevClose: number | null = null;

    const closes = result.indicators?.quote?.[0]?.close;
    if (closes && closes.length >= 2) {
      const validCloses = closes.filter((c): c is number => c != null && c > 0);
      if (validCloses.length >= 2) {
        prevClose = validCloses[validCloses.length - 2];
      }
    }

    // Fallback to meta fields if chart data insufficient
    if (!prevClose) {
      prevClose = result.meta?.previousClose ?? result.meta?.chartPreviousClose ?? null;
    }

    let pctChange = 0;
    let absChange = 0;
    if (prevClose && prevClose > 0) {
      absChange = price - prevClose;
      pctChange = (absChange / prevClose) * 100;
    }

    return { price, pctChange, absChange };
  } catch (err) {
    console.warn(`[market-snapshot/Yahoo] ${symbol} error: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TwelveData — raw quote fetch (used for BTC/USD)
// ---------------------------------------------------------------------------

interface TwelveDataRaw {
  price:     number;
  pctChange: number;
  absChange: number;
}

interface TwelveDataQuoteResponse {
  close?:          string;
  previous_close?: string;
  change?:         string;
  percent_change?: string | null;
  code?:           number;
  message?:        string;
}

async function fetchTwelveDataQuote(
  apiKey: string,
  symbol: string,
): Promise<TwelveDataRaw | null> {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), cache: "no-store" }
    );
    if (!res.ok) {
      console.warn(`[market-snapshot/TD] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const raw = (await res.json()) as TwelveDataQuoteResponse;
    if (raw.code) {
      console.warn(`[market-snapshot/TD] ${symbol}: ${raw.message}`);
      return null;
    }
    if (!raw.close) return null;

    const price = parseFloat(raw.close);
    if (isNaN(price)) return null;

    // Compute percent change with fallback
    let pct = raw.percent_change != null ? parseFloat(raw.percent_change) : NaN;
    if (isNaN(pct) || Math.abs(pct) < 0.005) {
      const chg  = raw.change         != null ? parseFloat(raw.change)         : NaN;
      const prev = raw.previous_close != null ? parseFloat(raw.previous_close) : NaN;
      const computed = (!isNaN(chg) && !isNaN(prev) && prev > 0) ? (chg / prev) * 100 : NaN;
      if (!isNaN(computed) && Math.abs(computed) >= 0.005) pct = computed;
    }
    if (isNaN(pct)) pct = 0;

    const absChange = raw.change != null ? parseFloat(raw.change) : 0;

    return { price, pctChange: pct, absChange: isNaN(absChange) ? 0 : absChange };
  } catch (err) {
    console.error(`[market-snapshot/TD] ${symbol} error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): MarketSnapshotData {
  return {
    items:       [],
    generatedAt: new Date().toISOString(),
    validUntil:  new Date(Date.now() + 60_000).toISOString(),
  };
}
