import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { MarketSnapshotItem, MarketPricesData } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-prices";
const CACHE_SECONDS = 5 * 60; // 5 minutes — matches market-snapshot cadence

/**
 * GET /api/market-prices
 * Returns five Market Prices indicators for the homepage MacroBoard:
 *   S&P 500, VIX, WTI Oil, Dollar Index, Bitcoin
 *
 * Source priority (real-time first, graceful-degrade):
 *   S&P 500    → TwelveData SPX → FRED SP500 (daily fallback)
 *   VIX        → TwelveData VIX → FRED VIXCLS (daily fallback)
 *   WTI Oil    → TwelveData WTI/USD → EIA → FRED DCOILWTICO
 *   Dollar Idx → TwelveData DXY → FRED DTWEXBGS
 *   Bitcoin    → TwelveData BTC/USD → FMP BTCUSD
 *
 * TTL: 5-min server-side Redis cache
 * Returns sessionStatus + refreshIntervalMs for client smart polling.
 */
export async function GET() {
  const kv = getRedisClient();
  const session = getMarketSession();

  if (!kv) {
    const data = await buildPrices(session);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  }

  try {
    const cached = await kv.get<MarketPricesData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      return NextResponse.json(
        { ...cached, sessionStatus: session.status, refreshIntervalMs: session.refreshMs },
        { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } }
      );
    }

    const data = await buildPrices(session);
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[/api/market-prices] Error:", err);
    const fallback = await buildPrices(session).catch(() => emptyPrices(session));
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Trading session detection (US Eastern Time, DST-aware)
// ---------------------------------------------------------------------------

function getMarketSession(): { status: "open" | "extended" | "closed"; refreshMs: number } {
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const day = etNow.getDay();
  const tm  = etNow.getHours() * 60 + etNow.getMinutes();

  if (day >= 1 && day <= 5) {
    if (tm >= 9 * 60 + 30 && tm < 16 * 60)  return { status: "open",     refreshMs: 5 * 60_000 };
    if (tm >= 16 * 60      && tm < 20 * 60)  return { status: "extended", refreshMs: 5 * 60_000 };
  }
  return { status: "closed", refreshMs: 5 * 60_000 };
}

// ---------------------------------------------------------------------------
// Main builder — TwelveData real-time first, FRED fallback
// ---------------------------------------------------------------------------

async function buildPrices(
  session: { status: "open" | "extended" | "closed"; refreshMs: number }
): Promise<MarketPricesData> {
  const now      = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  // ── Phase 1: FRED baselines ──────────────────────────────────────────────
  const [sp500Res, vixRes, wtiEiaRes, wtiCoRes, dxFredRes] = await Promise.allSettled([
    fetchFredSeries("SP500",      3),
    fetchFredSeries("VIXCLS",     3),
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

  // VIX (FRED baseline — points, not percent)
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

  // WTI Oil (EIA primary, FRED fallback)
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

  // Dollar Index (FRED baseline)
  const dxObs = dxFredRes.status === "fulfilled" ? dxFredRes.value : [];
  if (dxObs.length >= 1) {
    const latest = parseFloat(dxObs[0].value);
    const prev   = dxObs.length >= 2 ? parseFloat(dxObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("Dollar Index", {
        label:     "Dollar Index",
        value:     latest.toFixed(2),
        change:    Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
        source:    "FRED",
      });
    }
  }

  // ── Phase 2: TwelveData real-time override ─────────────────────────────
  const twKey  = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  if (twKey) {
    const tdResults = await Promise.allSettled([
      fetchTwelveDataSingle(twKey, "SPX",     "S&P 500",     (p) => Math.round(p).toLocaleString(), "percent"),
      fetchTwelveDataSingle(twKey, "VIX",     "VIX",         (p) => p.toFixed(2),                   "points"),
      fetchTwelveDataSingle(twKey, "WTI/USD", "WTI Oil",     (p) => `$${p.toFixed(2)}`,             "percent"),
      fetchTwelveDataSingle(twKey, "DXY",     "Dollar Index",(p) => p.toFixed(2),                   "percent"),
      fetchTwelveDataSingle(twKey, "BTC/USD", "Bitcoin",     (p) => `$${Math.round(p).toLocaleString()}`, "percent"),
    ]);

    for (const result of tdResults) {
      if (result.status === "fulfilled" && result.value) {
        itemMap.set(result.value.label, result.value);
      }
    }
  }

  // FMP fallback for DXY and BTC if TwelveData failed
  if (fmpKey && (!itemMap.has("Dollar Index") || !itemMap.has("Bitcoin") || itemMap.get("Dollar Index")?.source === "FRED")) {
    const fmpItems = await fetchFmpPrices(fmpKey, !itemMap.has("Dollar Index") || itemMap.get("Dollar Index")?.source === "FRED", !itemMap.has("Bitcoin"));
    for (const item of fmpItems) itemMap.set(item.label, item);
  }

  // ── Output in display order ────────────────────────────────────────────
  const ORDER = ["S&P 500", "VIX", "WTI Oil", "Dollar Index", "Bitcoin"];
  const items = ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  return {
    items: items.slice(0, 5),
    sessionStatus:     session.status,
    refreshIntervalMs: session.refreshMs,
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData — single symbol fetch
// ---------------------------------------------------------------------------

interface TwelveDataQuote {
  close?:          string;
  previous_close?: string;
  change?:         string;
  percent_change?: string | null;
  code?:           number;
  message?:        string;
}

async function fetchTwelveDataSingle(
  apiKey: string,
  symbol: string,
  label: string,
  formatValue: (price: number) => string,
  changeMode: "percent" | "points" = "percent",
): Promise<MarketSnapshotItem | null> {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), cache: "no-store" }
    );
    if (!res.ok) {
      console.warn(`[market-prices/TwelveData] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const raw = (await res.json()) as TwelveDataQuote;
    if (raw.code) {
      console.warn(`[market-prices/TwelveData] ${symbol}: ${raw.message}`);
      return null;
    }
    if (!raw.close) return null;

    const price = parseFloat(raw.close);
    if (isNaN(price)) return null;

    let changeStr: string;
    let direction: "up" | "down" | "flat";

    if (changeMode === "points") {
      const pts = parseFloat(raw.change ?? "0");
      const safe = isNaN(pts) ? 0 : pts;
      changeStr = Math.abs(safe) < 0.005 ? "—" : `${safe >= 0 ? "+" : ""}${safe.toFixed(2)}`;
      direction = safe > 0.005 ? "up" : safe < -0.005 ? "down" : "flat";
    } else {
      let pct = raw.percent_change != null ? parseFloat(raw.percent_change) : NaN;
      if (isNaN(pct) || Math.abs(pct) < 0.005) {
        const chg  = raw.change         != null ? parseFloat(raw.change)         : NaN;
        const prev = raw.previous_close != null ? parseFloat(raw.previous_close) : NaN;
        const computed = (!isNaN(chg) && !isNaN(prev) && prev > 0) ? (chg / prev) * 100 : NaN;
        if (!isNaN(computed) && Math.abs(computed) >= 0.005) pct = computed;
      }
      if (isNaN(pct)) pct = 0;
      changeStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      direction = pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat";
    }

    return {
      label,
      value:     formatValue(price),
      change:    changeStr,
      direction,
      source:    "TwelveData",
    };
  } catch (err) {
    console.error(`[market-prices/TwelveData] ${symbol} fetch error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FMP — fallback for DXY + BTC
// ---------------------------------------------------------------------------

interface FmpQuote {
  symbol:            string;
  price:             number;
  changesPercentage: number;
}

async function fetchFmpPrices(
  apiKey: string,
  needDxy: boolean,
  needBtc: boolean,
): Promise<MarketSnapshotItem[]> {
  const symbols: string[] = [];
  if (needDxy) symbols.push("DX-Y.NYB");
  if (needBtc) symbols.push("BTCUSD");
  if (symbols.length === 0) return [];

  try {
    const res = await fetch(
      `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), cache: "no-store" }
    );
    if (!res.ok) return [];

    const quotes = (await res.json()) as FmpQuote[];
    if (!Array.isArray(quotes)) return [];

    return quotes.flatMap((q) => {
      const pct    = q.changesPercentage ?? 0;
      const pctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      const dir    = (pct > 0 ? "up" : pct < 0 ? "down" : "flat") as "up" | "down" | "flat";

      if (q.symbol === "DX-Y.NYB") {
        return [{
          label:     "Dollar Index",
          value:     q.price.toFixed(2),
          change:    pctStr,
          direction: dir,
          source:    "FMP",
        }];
      }
      if (q.symbol === "BTCUSD") {
        return [{
          label:     "Bitcoin",
          value:     `$${Math.round(q.price).toLocaleString()}`,
          change:    pctStr,
          direction: dir,
          source:    "FMP",
        }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Empty fallback
// ---------------------------------------------------------------------------

function emptyPrices(session: { status: string; refreshMs: number }): MarketPricesData {
  return {
    items:             [],
    sessionStatus:     session.status as "open" | "extended" | "closed",
    refreshIntervalMs: session.refreshMs,
    generatedAt:       new Date().toISOString(),
    validUntil:        new Date(Date.now() + 60_000).toISOString(),
  };
}
