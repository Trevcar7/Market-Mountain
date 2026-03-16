import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { MarketSnapshotData, MarketSnapshotItem } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-snapshot";
const CACHE_SECONDS = 5 * 60; // 5 minutes — real-time data refreshes every 5 min

/**
 * GET /api/market-snapshot
 * Returns six core market indicators for the homepage strip + MacroBoard:
 *   S&P 500, VIX, 10Y Yield, WTI Oil, Broad U.S. Dollar Index, BTC
 *
 * Source priority (per-indicator, real-time first, graceful-degrade):
 *   S&P 500 → FMP ^GSPC (real-time) → TwelveData SPX → FRED SP500 (daily)
 *   VIX     → FMP ^VIX (real-time)  → TwelveData VIX → FRED VIXCLS (daily)
 *   10Y     → FRED DGS10 (daily — yields don't need intraday)
 *   WTI Oil → TwelveData WTI/USD → EIA → FRED DCOILWTICO
 *   DXY     → TwelveData DXY → FRED DTWEXBGS
 *   BTC     → TwelveData BTC/USD → FMP BTCUSD
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
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });

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
// Snapshot builder — real-time sources first, FRED daily as fallback
// ---------------------------------------------------------------------------

async function buildSnapshot(): Promise<MarketSnapshotData> {
  const now      = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  const twKey  = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

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

  // 10Y Treasury Yield — change in basis points (FRED is fine for yields)
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
  // Each call is isolated — one failure never blocks another.
  // These override FRED baselines with fresher data when available.
  if (twKey) {
    const tdResults = await Promise.allSettled([
      fetchTwelveDataQuote(twKey, "SPX",     "S&P 500",               (p) => Math.round(p).toLocaleString(), "percent"),
      fetchTwelveDataQuote(twKey, "VIX",     "VIX",                   (p) => p.toFixed(2),                   "points"),
      fetchTwelveDataQuote(twKey, "WTI/USD", "WTI Oil",               (p) => `$${p.toFixed(2)}`,             "percent"),
      fetchTwelveDataQuote(twKey, "DXY",     "Broad U.S. Dollar Index",(p) => p.toFixed(2),                  "percent"),
      fetchTwelveDataQuote(twKey, "BTC/USD", "BTC",                   (p) => `$${Math.round(p).toLocaleString()}`, "percent"),
    ]);

    for (const result of tdResults) {
      if (result.status === "fulfilled" && result.value) {
        itemMap.set(result.value.label, result.value);
      }
    }
  }

  // ── Phase 3: FMP supplementary (most accurate for US indices) ──────────
  // FMP provides real-time data for ^GSPC and ^VIX — overrides TwelveData
  // (which may be 15-min delayed for US indices on free tier).
  if (fmpKey) {
    const needBtc = !itemMap.has("BTC");
    const fmpItems = await fetchFmpSnapshot(fmpKey, needBtc);
    for (const item of fmpItems) itemMap.set(item.label, item);
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
// TwelveData — single-symbol quote with flexible change format
// ---------------------------------------------------------------------------

interface TwelveDataQuoteResponse {
  close?:          string;
  previous_close?: string;
  change?:         string;       // absolute change from previous close
  percent_change?: string | null;
  code?:           number;
  message?:        string;
}

async function fetchTwelveDataQuote(
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
      console.warn(`[market-snapshot/TwelveData] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const raw = (await res.json()) as TwelveDataQuoteResponse;
    if (raw.code) {
      console.warn(`[market-snapshot/TwelveData] ${symbol}: ${raw.message}`);
      return null;
    }
    if (!raw.close) return null;

    const price = parseFloat(raw.close);
    if (isNaN(price)) return null;

    let changeStr: string;
    let direction: "up" | "down" | "flat";

    if (changeMode === "points") {
      // VIX: show absolute change in points (e.g., "+1.23")
      const pts = parseFloat(raw.change ?? "0");
      const safePoints = isNaN(pts) ? 0 : pts;
      changeStr = Math.abs(safePoints) < 0.005 ? "—" : `${safePoints >= 0 ? "+" : ""}${safePoints.toFixed(2)}`;
      direction = safePoints > 0.005 ? "up" : safePoints < -0.005 ? "down" : "flat";
    } else {
      // Percent change (default)
      let pct = raw.percent_change != null ? parseFloat(raw.percent_change) : NaN;

      // Fallback: compute from change/previous_close when percent_change is null/zero
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
    console.error(`[market-snapshot/TwelveData] ${symbol} error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FMP — supplementary real-time for S&P 500 + VIX (overrides TwelveData)
// ---------------------------------------------------------------------------

interface FmpQuote {
  symbol:            string;
  price:             number;
  changesPercentage: number;
  change?:           number;
}

async function fetchFmpSnapshot(
  apiKey: string,
  needBtc: boolean,
): Promise<MarketSnapshotItem[]> {
  const symbols = ["%5EGSPC", "%5EVIX"];
  if (needBtc) symbols.push("BTCUSD");

  try {
    const res = await fetch(
      `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), cache: "no-store" }
    );
    if (!res.ok) {
      console.warn(`[market-snapshot/FMP] HTTP ${res.status}`);
      return [];
    }

    const quotes = (await res.json()) as FmpQuote[];
    if (!Array.isArray(quotes)) {
      console.warn("[market-snapshot/FMP] unexpected response format");
      return [];
    }

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
        const pts = q.change ?? 0;
        result.push({
          label:     "VIX",
          value:     q.price.toFixed(2),
          change:    Math.abs(pts) < 0.005 ? "—" : `${pts >= 0 ? "+" : ""}${pts.toFixed(2)}`,
          direction: (pts > 0.005 ? "up" : pts < -0.005 ? "down" : "flat") as "up" | "down" | "flat",
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
  } catch (err) {
    console.warn("[market-snapshot/FMP] fetch error:", err);
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
