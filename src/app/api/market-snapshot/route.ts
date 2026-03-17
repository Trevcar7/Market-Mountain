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
 *   S&P 500, VIX, 10Y Yield, WTI Oil, Broad U.S. Dollar Index, BTC
 *
 * Data source strategy:
 *   FRED provides daily-close baselines for all instruments.
 *   TwelveData ETF proxies (SPY, USO, UUP) provide real-time % change
 *   which is applied to the FRED baseline to compute approximate current values.
 *   BTC/USD is fetched directly from TwelveData (crypto, real-time on free tier).
 *   VIX and 10Y Yield use FRED only (no accurate free-tier real-time proxy).
 *
 * TTL: 5-min server-side Redis cache
 */
export async function GET() {
  const kv = getRedisClient();

  if (!kv) {
    const data = await buildSnapshot();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  }

  try {
    const cached = await kv.get<MarketSnapshotData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
      });
    }

    const data = await buildSnapshot();

    // Only cache if we got meaningful data (≥3 items).
    // If FRED/TwelveData are down, don't cache the partial result
    // so the next request retries fresh.
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
    const fallback = await buildSnapshot().catch(() => emptySnapshot());
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

async function buildSnapshot(): Promise<MarketSnapshotData> {
  const now        = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);
  const twKey      = process.env.TWELVEDATA_API_KEY;

  // ── Phase 1: FRED baselines (daily close) — always available ───────────
  const [sp500Res, vixRes, tenYearRes, wtiEiaRes, wtiCoRes, dxFredRes] = await Promise.allSettled([
    fetchFredSeries("SP500",      3),
    fetchFredSeries("VIXCLS",     3),
    fetchFredSeries("DGS10",      3),
    fetchWtiCrudePrice(),
    fetchFredSeries("DCOILWTICO", 3),
    fetchFredSeries("DTWEXBGS",   2),
  ]);

  const itemMap = new Map<string, MarketSnapshotItem>();

  // S&P 500 (FRED baseline)
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

  // VIX — change in POINTS, not percent (industry standard)
  const vixObs = vixRes.status === "fulfilled" ? vixRes.value : [];
  if (vixObs.length >= 1) {
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

  // WTI Crude Oil — EIA primary, FRED fallback
  if (wtiEiaRes.status === "fulfilled" && wtiEiaRes.value?.value != null) {
    itemMap.set("WTI Oil", {
      label:     "WTI Oil",
      value:     `$${wtiEiaRes.value.value.toFixed(2)}`,
      change:    "—",
      direction: "flat",
      source:    "EIA",
    });
  } else {
    const wtiObs = wtiCoRes.status === "fulfilled" ? wtiCoRes.value : [];
    if (wtiObs.length >= 1) {
      const latest = parseFloat(wtiObs[0].value);
      const prev   = wtiObs.length >= 2 ? parseFloat(wtiObs[1].value) : NaN;
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

  // Dollar Index — FRED DTWEXBGS baseline
  const dxObs = dxFredRes.status === "fulfilled" ? dxFredRes.value : [];
  if (dxObs.length >= 1) {
    const latest = parseFloat(dxObs[0].value);
    const prev   = dxObs.length >= 2 ? parseFloat(dxObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("Broad U.S. Dollar Index", {
        label:     "Broad U.S. Dollar Index",
        value:     latest.toFixed(2),
        change:    Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
        source:    "FRED",
      });
    }
  }

  // ── Phase 2: TwelveData real-time override ─────────────────────────────
  // ETF proxies provide real-time % change on the free tier.
  // We apply that % change to the FRED baseline to get approximate current values.
  // BTC/USD is fetched directly (crypto pairs are real-time on free tier).
  if (twKey) {
    // Batch 1: SPY (S&P proxy) + BTC/USD (direct) + USO (WTI proxy) — 3 credits
    const [spyRes, btcRes, usoRes] = await Promise.allSettled([
      fetchTwelveDataQuote(twKey, "SPY"),
      fetchTwelveDataQuote(twKey, "BTC/USD"),
      fetchTwelveDataQuote(twKey, "USO"),
    ]);

    // S&P 500: apply SPY % change to FRED baseline
    if (spyRes.status === "fulfilled" && spyRes.value) {
      const spy = spyRes.value;
      const fredBase = parseFredValue(itemMap.get("S&P 500")?.value);
      if (!isNaN(fredBase) && fredBase > 0) {
        const approx = Math.round(fredBase * (1 + spy.pctChange / 100));
        itemMap.set("S&P 500", {
          label:     "S&P 500",
          value:     approx.toLocaleString(),
          change:    `${spy.pctChange >= 0 ? "+" : ""}${spy.pctChange.toFixed(2)}%`,
          direction: spy.pctChange > 0.01 ? "up" : spy.pctChange < -0.01 ? "down" : "flat",
          source:    "TwelveData",
        });
      }
    }

    // BTC: direct value from TwelveData
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

    // WTI Oil: apply USO % change to FRED baseline
    if (usoRes.status === "fulfilled" && usoRes.value) {
      const uso = usoRes.value;
      const fredBase = parseFredValue(itemMap.get("WTI Oil")?.value);
      if (!isNaN(fredBase) && fredBase > 0) {
        const approx = fredBase * (1 + uso.pctChange / 100);
        itemMap.set("WTI Oil", {
          label:     "WTI Oil",
          value:     `$${approx.toFixed(2)}`,
          change:    `${uso.pctChange >= 0 ? "+" : ""}${uso.pctChange.toFixed(2)}%`,
          direction: uso.pctChange > 0.005 ? "up" : uso.pctChange < -0.005 ? "down" : "flat",
          source:    "TwelveData",
        });
      }
    }

    // Brief pause to avoid TwelveData 8-credits/minute rate limit
    await new Promise((r) => setTimeout(r, 1500));

    // Batch 2: UUP (DXY proxy) — 1 credit
    const [uupRes] = await Promise.allSettled([
      fetchTwelveDataQuote(twKey, "UUP"),
    ]);

    // Dollar Index: apply UUP % change to FRED baseline
    if (uupRes.status === "fulfilled" && uupRes.value) {
      const uup = uupRes.value;
      const fredBase = parseFredValue(itemMap.get("Broad U.S. Dollar Index")?.value);
      if (!isNaN(fredBase) && fredBase > 0) {
        const approx = fredBase * (1 + uup.pctChange / 100);
        itemMap.set("Broad U.S. Dollar Index", {
          label:     "Broad U.S. Dollar Index",
          value:     approx.toFixed(2),
          change:    `${uup.pctChange >= 0 ? "+" : ""}${uup.pctChange.toFixed(2)}%`,
          direction: uup.pctChange > 0.005 ? "up" : uup.pctChange < -0.005 ? "down" : "flat",
          source:    "TwelveData",
        });
      }
    }
  }

  // ── Output in display order ────────────────────────────────────────────
  const STRIP_ORDER = ["S&P 500", "VIX", "10Y Yield", "WTI Oil", "Broad U.S. Dollar Index", "BTC"];
  const items = STRIP_ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  return {
    items: items.slice(0, 7),
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData — raw quote fetch (returns price + pctChange for hybrid use)
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
