import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MarketSnapshotData, MarketSnapshotItem } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-snapshot";
const CACHE_SECONDS = 60;

/**
 * GET /api/market-snapshot
 * Returns seven core market indicators for the homepage strip:
 *   S&P 500, VIX, 10Y Yield, WTI Oil, Gold, Broad U.S. Dollar Index, Bitcoin
 *
 * Source priority (per-indicator, graceful-degrade):
 *   S&P 500    → FRED SP500
 *   VIX        → FRED VIXCLS — change shown in POINTS, not %
 *   10Y Yield  → FRED DGS10 — change in basis points
 *   WTI Oil    → EIA live → FRED DCOILWTICO fallback
 *   Gold       → TwelveData XAU/USD → FMP XAUUSD → FRED GOLDAMGBD228NLBM
 *   Broad U.S. Dollar Index → FRED DTWEXBGS (Trade Weighted Broad Dollar Index)
 *   Bitcoin    → TwelveData BTC/USD → FMP BTCUSD
 *   FMP also overrides S&P 500 + VIX with intraday data when key is set
 *
 * TTL: 60s server-side Redis cache
 */
export async function GET() {
  const url   = process.env.KV_REST_API_URL;
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
// Snapshot builder
// ---------------------------------------------------------------------------

async function buildSnapshot(): Promise<MarketSnapshotData> {
  const now      = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  // All FRED/EIA fetches in parallel — each degrades independently
  const [sp500Res, vixRes, tenYearRes, wtiEiaRes, wtiCoRes, dxFredRes, goldFredRes] = await Promise.allSettled([
    fetchFredSeries("SP500",            3),   // S&P 500 daily close
    fetchFredSeries("VIXCLS",           3),   // CBOE VIX daily close
    fetchFredSeries("DGS10",            3),   // 10-Year Treasury yield
    fetchWtiCrudePrice(),                     // EIA WTI spot (primary)
    fetchFredSeries("DCOILWTICO",       3),   // FRED WTI fallback
    fetchFredSeries("DTWEXBGS",         2),   // FRED Broad USD Index fallback for DXY
    fetchFredSeries("GOLDAMGBD228NLBM", 3),   // FRED Gold (London AM fix) fallback
  ]);

  const itemMap = new Map<string, MarketSnapshotItem>();

  // ── S&P 500 (FRED baseline) ───────────────────────────────────────────────
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

  // ── VIX — change in POINTS, not percent (industry standard) ──────────────
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

  // ── 10Y Treasury Yield — change in basis points ───────────────────────────
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

  // ── WTI Crude Oil — EIA primary, FRED DCOILWTICO fallback ─────────────────
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

  // ── TwelveData (Gold, BTC) — fetched in parallel, each fails independently ──
  const twKey  = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  const [goldTwRes, btcTwRes] = await Promise.allSettled([
    twKey ? fetchTwelveDataSingle(twKey, "XAU/USD", "Gold", (p) => `$${Math.round(p).toLocaleString()}`) : Promise.resolve(null),
    twKey ? fetchTwelveDataSingle(twKey, "BTC/USD",  "BTC",  (p) => `$${Math.round(p).toLocaleString()}`) : Promise.resolve(null),
  ]);
  if (goldTwRes.status === "fulfilled" && goldTwRes.value) itemMap.set("Gold", goldTwRes.value);
  if (btcTwRes.status  === "fulfilled" && btcTwRes.value)  itemMap.set("BTC",  btcTwRes.value);

  // FMP fallback for missing live symbols — also overrides FRED S&P 500 + VIX with intraday
  if (fmpKey) {
    const needGold = !itemMap.has("Gold");
    const needBtc  = !itemMap.has("BTC");
    const fmpItems = await fetchFmpSnapshot(fmpKey, needGold, needBtc);
    for (const item of fmpItems) itemMap.set(item.label, item);
  }

  // FRED GOLDAMGBD228NLBM last-resort fallback for Gold
  if (!itemMap.has("Gold")) {
    const goldObs = goldFredRes.status === "fulfilled" ? goldFredRes.value : [];
    if (goldObs.length >= 1) {
      const latest = parseFloat(goldObs[0].value);
      const prev   = goldObs.length >= 2 ? parseFloat(goldObs[1].value) : NaN;
      if (!isNaN(latest)) {
        const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
        itemMap.set("Gold", {
          label:     "Gold",
          value:     `$${Math.round(latest).toLocaleString()}`,
          change:    Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
          source:    "FRED",
        });
      }
    }
  }

  // FRED DTWEXBGS — Trade Weighted Broad Dollar Index (USD Index)
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

  const STRIP_ORDER = ["S&P 500", "VIX", "10Y Yield", "WTI Oil", "Gold", "Broad U.S. Dollar Index", "BTC"];
  const items = STRIP_ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  return {
    items: items.slice(0, 7),
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData — single symbol fetch (isolated — one symbol never breaks another)
// ---------------------------------------------------------------------------

interface TwelveDataQuote {
  close?:          string;
  previous_close?: string;       // absolute previous close — used for pct fallback
  change?:         string;       // absolute change from previous close
  percent_change?: string | null; // may be null for some commodity/forex symbols
  code?:           number;
  message?:        string;
}

async function fetchTwelveDataSingle(
  apiKey: string,
  symbol: string,
  label: string,
  formatValue: (price: number) => string,
): Promise<MarketSnapshotItem | null> {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 60 } }
    );
    if (!res.ok) {
      console.warn(`[market-snapshot/TwelveData] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const raw = (await res.json()) as TwelveDataQuote;
    if (raw.code) {
      console.warn(`[market-snapshot/TwelveData] ${symbol}: ${raw.message}`);
      return null;
    }
    if (!raw.close) return null;

    const price = parseFloat(raw.close);
    if (isNaN(price)) return null;

    // Prefer API's percent_change; fall back to change/previous_close if null/NaN
    // (TwelveData returns percent_change: null for some commodity/forex quotes)
    let pct = raw.percent_change != null ? parseFloat(raw.percent_change) : NaN;
    if (isNaN(pct)) {
      const chg  = raw.change         != null ? parseFloat(raw.change)         : NaN;
      const prev = raw.previous_close != null ? parseFloat(raw.previous_close) : NaN;
      pct = (!isNaN(chg) && !isNaN(prev) && prev > 0) ? (chg / prev) * 100 : 0;
    }

    return {
      label,
      value:     formatValue(price),
      change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
      source:    "Twelve Data",
    };
  } catch (err) {
    console.error(`[market-snapshot/TwelveData] ${symbol} error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FMP — fallback for Gold + BTC; also overrides S&P 500 + VIX with intraday
// ---------------------------------------------------------------------------

interface FmpQuote {
  symbol:            string;
  price:             number;
  changesPercentage: number;
  change?:           number;  // Absolute price change — used for VIX points
}

async function fetchFmpSnapshot(
  apiKey: string,
  needGold: boolean,
  needBtc:  boolean,
): Promise<MarketSnapshotItem[]> {
  // Always fetch S&P 500 + VIX for intraday override; add Gold/BTC as needed
  const symbols = ["^GSPC", "^VIX"];
  if (needGold) symbols.push("XAUUSD");
  if (needBtc)  symbols.push("BTCUSD");

  try {
    const res = await fetch(
      `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 60 } }
    );
    if (!res.ok) return [];

    const quotes = (await res.json()) as FmpQuote[];
    const result: MarketSnapshotItem[] = [];

    for (const q of quotes) {
      const pct = q.changesPercentage ?? 0;
      const dir = (pct > 0 ? "up" : pct < 0 ? "down" : "flat") as "up" | "down" | "flat";

      if (q.symbol === "^GSPC") {
        result.push({
          label:     "S&P 500",
          value:     Math.round(q.price).toLocaleString(),
          change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: dir,
          source:    "FMP",
        });
      } else if (q.symbol === "^VIX") {
        // VIX change in POINTS — use FMP's `change` field (absolute), not changesPercentage
        const pts = q.change ?? 0;
        result.push({
          label:     "VIX",
          value:     q.price.toFixed(2),
          change:    Math.abs(pts) < 0.005 ? "—" : `${pts >= 0 ? "+" : ""}${pts.toFixed(2)}`,
          direction: (pts > 0.005 ? "up" : pts < -0.005 ? "down" : "flat") as "up" | "down" | "flat",
          source:    "FMP",
        });
      } else if (q.symbol === "XAUUSD") {
        result.push({
          label:     "Gold",
          value:     `$${Math.round(q.price).toLocaleString()}`,
          change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: dir,
          source:    "FMP",
        });
      } else if (q.symbol === "BTCUSD") {
        result.push({
          label:     "BTC",
          value:     `$${Math.round(q.price).toLocaleString()}`,
          change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: dir,
          source:    "FMP",
        });
      }
    }

    return result;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Empty fallback
// ---------------------------------------------------------------------------

function emptySnapshot(): MarketSnapshotData {
  return {
    items:       [],
    generatedAt: new Date().toISOString(),
    validUntil:  new Date(Date.now() + 60_000).toISOString(),
  };
}
