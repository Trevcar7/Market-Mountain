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
 *   1. FMP (Financial Modeling Prep) — real-time direct quotes for indices.
 *      Individual API calls for ^GSPC, ^VIX, ^DXY (~3 credits).
 *   2. Yahoo Finance — unofficial but reliable same-day quote data.
 *   3. FRED — daily-close fallback (can lag 1 day on business days).
 *   4. TwelveData — BTC/USD (crypto, real-time on free tier).
 *
 * Why not "FRED baseline + ETF proxy %"?
 *   FRED SP500/VIXCLS/DCOILWTICO can lag 1-3 days. Applying today's ETF %
 *   change to a multi-day-old baseline produces wrong absolute values.
 *   FMP/Yahoo direct quotes give the actual current price — no proxy math needed.
 *
 * TTL: 5-min server-side Redis cache.
 * Pass ?_debug=1 for diagnostic info (FMP key status, source logs).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("_debug") === "1";
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

    // Only cache if we got meaningful data (>=3 items).
    if (data.items.length >= 3) {
      await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });
    } else {
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
// FMP types
// ---------------------------------------------------------------------------

interface FmpQuote {
  symbol:             string;
  price:              number;
  change:             number;
  changesPercentage:  number;
  previousClose?:     number;
  name?:              string;
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

async function buildSnapshot(debug = false): Promise<MarketSnapshotData> {
  const now        = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);
  const fmpKey     = process.env.FMP_API_KEY;
  const twKey      = process.env.TWELVEDATA_API_KEY;
  const debugLog: string[] = [];

  const itemMap = new Map<string, MarketSnapshotItem>();

  if (debug) {
    debugLog.push(`FMP_API_KEY: ${fmpKey ? `set (${fmpKey.length} chars)` : "NOT SET"}`);
    debugLog.push(`TWELVEDATA_API_KEY: ${twKey ? `set (${twKey.length} chars)` : "NOT SET"}`);
    debugLog.push(`FRED_API_KEY: ${process.env.FRED_API_KEY ? "set" : "NOT SET"}`);
  }

  // ── Phase 1: FMP direct quotes (real-time, most accurate) ──────────────
  // Individual API calls per symbol — more resilient than batch (one bad symbol
  // won't break the others). Uses ~3 credits total.
  if (fmpKey) {
    const fmpSymbols = [
      { fmp: "%5EGSPC", key: "S&P 500" },
      { fmp: "%5EVIX",  key: "VIX" },
      { fmp: "%5EDXY",  key: "DXY" },
    ] as const;

    const fmpResults = await Promise.allSettled(
      fmpSymbols.map(({ fmp }) =>
        fetch(
          `https://financialmodelingprep.com/api/v3/quote/${fmp}?apikey=${fmpKey}`,
          { signal: AbortSignal.timeout(8000), cache: "no-store" }
        ).then(async (res) => {
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const msg = `FMP ${fmp}: HTTP ${res.status} — ${body.slice(0, 200)}`;
            console.warn(`[market-snapshot] ${msg}`);
            if (debug) debugLog.push(msg);
            return null;
          }
          const data = await res.json();
          // FMP returns array for /quote, or error object
          if (debug) debugLog.push(`FMP ${fmp} raw: ${JSON.stringify(data).slice(0, 300)}`);
          const arr = Array.isArray(data) ? data : [];
          return arr[0] as FmpQuote | undefined;
        })
      )
    );

    for (let i = 0; i < fmpSymbols.length; i++) {
      const result = fmpResults[i];
      if (result.status === "rejected") {
        const msg = `FMP ${fmpSymbols[i].fmp}: rejected — ${String(result.reason)}`;
        console.warn(`[market-snapshot] ${msg}`);
        if (debug) debugLog.push(msg);
        continue;
      }
      if (!result.value) continue;
      const q = result.value;
      if (!q.price || q.price <= 0) continue;

      const pct = q.changesPercentage ?? 0;
      const abs = q.change ?? 0;
      const { key } = fmpSymbols[i];

      if (key === "S&P 500") {
        itemMap.set("S&P 500", {
          label:     "S&P 500",
          value:     Math.round(q.price).toLocaleString(),
          change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: pct > 0.01 ? "up" : pct < -0.01 ? "down" : "flat",
          source:    "FMP",
        });
      } else if (key === "VIX") {
        // VIX change is in points, not percent (industry standard)
        itemMap.set("VIX", {
          label:     "VIX",
          value:     q.price.toFixed(2),
          change:    Math.abs(abs) < 0.005 ? "—" : `${abs >= 0 ? "+" : ""}${abs.toFixed(2)}`,
          direction: abs > 0.005 ? "up" : abs < -0.005 ? "down" : "flat",
          source:    "FMP",
        });
      } else if (key === "DXY") {
        itemMap.set("DXY", {
          label:     "DXY",
          value:     q.price.toFixed(2),
          change:    Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
          source:    "FMP",
        });
      }

      console.log(`[market-snapshot] FMP ${key}: ${q.price} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
      if (debug) debugLog.push(`FMP ${key}: ${q.price} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
    }
  } else if (debug) {
    debugLog.push("FMP SKIPPED — no API key");
  }

  // ── Phase 1.5: Yahoo Finance fallback (same-day quotes, no key needed) ──
  // Fills S&P 500, VIX, DXY if FMP didn't provide them.
  {
    const yahooNeeded: { symbol: string; key: string }[] = [];
    if (!itemMap.has("S&P 500")) yahooNeeded.push({ symbol: "^GSPC", key: "S&P 500" });
    if (!itemMap.has("VIX"))     yahooNeeded.push({ symbol: "^VIX",  key: "VIX" });
    if (!itemMap.has("DXY"))     yahooNeeded.push({ symbol: "DX-Y.NYB", key: "DXY" });

    if (yahooNeeded.length > 0) {
      if (debug) debugLog.push(`Yahoo Finance: fetching ${yahooNeeded.map(y => y.symbol).join(", ")}`);
      const yahooResults = await Promise.allSettled(
        yahooNeeded.map(({ symbol }) => fetchYahooQuote(symbol))
      );

      for (let i = 0; i < yahooNeeded.length; i++) {
        const result = yahooResults[i];
        if (result.status !== "fulfilled" || !result.value) {
          if (debug) debugLog.push(`Yahoo ${yahooNeeded[i].symbol}: ${result.status === "rejected" ? String(result.reason) : "null"}`);
          continue;
        }
        const yq = result.value;
        const { key } = yahooNeeded[i];

        if (key === "S&P 500") {
          itemMap.set("S&P 500", {
            label:     "S&P 500",
            value:     Math.round(yq.price).toLocaleString(),
            change:    `${yq.pctChange >= 0 ? "+" : ""}${yq.pctChange.toFixed(2)}%`,
            direction: yq.pctChange > 0.01 ? "up" : yq.pctChange < -0.01 ? "down" : "flat",
            source:    "Yahoo",
          });
        } else if (key === "VIX") {
          const abs = yq.absChange;
          itemMap.set("VIX", {
            label:     "VIX",
            value:     yq.price.toFixed(2),
            change:    Math.abs(abs) < 0.005 ? "—" : `${abs >= 0 ? "+" : ""}${abs.toFixed(2)}`,
            direction: abs > 0.005 ? "up" : abs < -0.005 ? "down" : "flat",
            source:    "Yahoo",
          });
        } else if (key === "DXY") {
          itemMap.set("DXY", {
            label:     "DXY",
            value:     yq.price.toFixed(2),
            change:    Math.abs(yq.pctChange) < 0.005 ? "—" : `${yq.pctChange >= 0 ? "+" : ""}${yq.pctChange.toFixed(2)}%`,
            direction: yq.pctChange > 0.005 ? "up" : yq.pctChange < -0.005 ? "down" : "flat",
            source:    "Yahoo",
          });
        }

        console.log(`[market-snapshot] Yahoo ${key}: ${yq.price}`);
        if (debug) debugLog.push(`Yahoo ${key}: ${yq.price} (${yq.pctChange >= 0 ? "+" : ""}${yq.pctChange.toFixed(2)}%)`);
      }
    }
  }

  // ── Phase 2: FRED fallback (daily close) — fills gaps FMP didn't cover ─
  const fredNeeded = {
    sp500:  !itemMap.has("S&P 500"),
    vix:    !itemMap.has("VIX"),
    tenY:   true,  // Always fetch 10Y for the strip (FMP batch doesn't include it)
    wti:    !itemMap.has("WTI Oil"),
  };

  const fredPromises = await Promise.allSettled([
    fredNeeded.sp500 ? fetchFredSeries("SP500",      3) : Promise.resolve([]),
    fredNeeded.vix   ? fetchFredSeries("VIXCLS",     3) : Promise.resolve([]),
    fredNeeded.tenY  ? fetchFredSeries("DGS10",      3) : Promise.resolve([]),
    fredNeeded.wti   ? fetchWtiCrudePrice()              : Promise.resolve(null),
    fredNeeded.wti   ? fetchFredSeries("DCOILWTICO", 3) : Promise.resolve([]),
  ]);

  const sp500Obs    = fredPromises[0].status === "fulfilled" ? fredPromises[0].value as { date: string; value: string }[] : [];
  const vixObs      = fredPromises[1].status === "fulfilled" ? fredPromises[1].value as { date: string; value: string }[] : [];
  const tenYearObs  = fredPromises[2].status === "fulfilled" ? fredPromises[2].value as { date: string; value: string }[] : [];
  const wtiEiaVal   = fredPromises[3].status === "fulfilled" ? fredPromises[3].value as { value: number; period: string } | null : null;
  const wtiCoObs    = fredPromises[4].status === "fulfilled" ? fredPromises[4].value as { date: string; value: string }[] : [];
  // dxFredObs unused now since we always prefer FMP for DXY

  // S&P 500 fallback
  if (!itemMap.has("S&P 500") && sp500Obs.length >= 1) {
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

  // VIX fallback
  if (!itemMap.has("VIX") && vixObs.length >= 1) {
    const latest = parseFloat(vixObs[0].value);
    const prev   = vixObs.length >= 2 ? parseFloat(vixObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pts = !isNaN(prev) ? latest - prev : 0;
      itemMap.set("VIX", {
        label:     "VIX",
        value:     latest.toFixed(2),
        change:    Math.abs(pts) < 0.005 ? "—" : `${pts >= 0 ? "+" : ""}${pts.toFixed(2)}`,
        direction: pts > 0.005 ? "up" : pts < -0.005 ? "down" : "flat",
        source:    "FRED",
      });
    }
  }

  // 10Y Treasury Yield — change in basis points
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
        label:     "WTI Oil",
        value:     `$${wtiEiaVal.value.toFixed(2)}`,
        change:    "—",
        direction: "flat",
        source:    "EIA",
      });
    } else if (wtiCoObs.length >= 1) {
      const latest = parseFloat(wtiCoObs[0].value);
      const prev   = wtiCoObs.length >= 2 ? parseFloat(wtiCoObs[1].value) : NaN;
      if (!isNaN(latest)) {
        const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
        itemMap.set("WTI Oil", {
          label:     "WTI Oil",
          value:     `$${latest.toFixed(2)}`,
          change:    Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
          source:    "FRED",
        });
      }
    }
  }

  // DXY: NO FRED fallback — FRED DTWEXBGS is the Trade-Weighted Broad Dollar
  // Index (~120), NOT the ICE DXY (~99). Showing 120 is worse than omitting.
  // DXY only appears if FMP provides it.

  // ── Phase 3: TwelveData — BTC/USD direct + USO overlay for WTI ────────
  if (twKey) {
    // BTC/USD is real-time on TwelveData free tier (crypto pairs)
    const [btcRes] = await Promise.allSettled([
      fetchTwelveDataQuote(twKey, "BTC/USD"),
    ]);

    if (btcRes.status === "fulfilled" && btcRes.value) {
      const btc = btcRes.value;
      itemMap.set("BTC", {
        label:     "BTC",
        value:     `$${Math.round(btc.price).toLocaleString()}`,
        change:    `${btc.pctChange >= 0 ? "+" : ""}${btc.pctChange.toFixed(2)}%`,
        direction: btc.pctChange > 0.005 ? "up" : btc.pctChange < -0.005 ? "down" : "flat",
        source:    "TwelveData",
      });
    }
  }

  // ── Output in display order ────────────────────────────────────────────
  const STRIP_ORDER = ["S&P 500", "VIX", "10Y Yield", "WTI Oil", "DXY", "BTC"];
  const items = STRIP_ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  const result: MarketSnapshotData & { _debug?: string[] } = {
    items: items.slice(0, 7),
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };

  if (debug) {
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
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2d`,
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

    // Get previous close for change calculation
    const prevClose = result.meta?.chartPreviousClose ?? result.meta?.previousClose;

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

/** Parse a formatted value like "6,632" or "$94.65" back to a number */
function parseFredValue(formatted: string | undefined): number {
  if (!formatted) return NaN;
  return parseFloat(formatted.replace(/[$,]/g, ""));
}

function emptySnapshot(): MarketSnapshotData {
  return {
    items:       [],
    generatedAt: new Date().toISOString(),
    validUntil:  new Date(Date.now() + 60_000).toISOString(),
  };
}
