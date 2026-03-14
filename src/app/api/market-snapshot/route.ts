import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MarketSnapshotData, MarketSnapshotItem } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-snapshot";
const CACHE_SECONDS = 60; // 60-second strip TTL — near-live

/**
 * GET /api/market-snapshot
 * Returns the six core market indicators for the homepage strip:
 *   S&P 500, 10Y Yield, WTI Oil, Bitcoin, VIX, Dollar Index
 *
 * Data sources (graceful-degrade):
 *   - FRED: 10Y yield, Fed Funds Rate
 *   - EIA: WTI crude oil
 *   - FMP: S&P 500, VIX, DXY, BTC (requires FMP_API_KEY)
 *   - Fallback: macro-board cache for yield/oil; no FMP → show FRED/EIA items only
 *
 * TTL: 60 seconds (strip is meant to feel live)
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

  const items: MarketSnapshotItem[] = [];

  // Fetch FRED 10Y yield + EIA WTI in parallel
  const [tenYearResult, wtiResult] = await Promise.allSettled([
    fetchFredSeries("DGS10", 5),         // 10-Year Treasury yield (daily)
    fetchWtiCrudePrice(),                // WTI crude oil spot price
  ]);

  // ── 10Y Treasury Yield ────────────────────────────────────────────────────
  if (tenYearResult.status === "fulfilled" && tenYearResult.value.length >= 2) {
    const obs = tenYearResult.value;
    const latest = parseFloat(obs[obs.length - 1]?.value ?? "");
    const prev   = parseFloat(obs[obs.length - 2]?.value ?? "");
    if (!isNaN(latest)) {
      const change = !isNaN(prev) ? latest - prev : 0;
      const changeBps = Math.round(change * 100);
      const changeStr = changeBps === 0 ? "flat" : `${changeBps > 0 ? "+" : ""}${changeBps}bps`;
      items.push({
        label: "10Y Yield",
        value: `${latest.toFixed(2)}%`,
        change: changeStr,
        direction: changeBps > 0 ? "up" : changeBps < 0 ? "down" : "flat",
        source: "FRED",
      });
    }
  }

  // ── WTI Crude Oil ─────────────────────────────────────────────────────────
  // fetchWtiCrudePrice returns { value: number; period: string } | null
  if (wtiResult.status === "fulfilled" && wtiResult.value !== null) {
    const wtiObj = wtiResult.value;
    if (wtiObj && typeof wtiObj.value === "number") {
      items.push({
        label: "WTI Oil",
        value: `$${wtiObj.value.toFixed(2)}`,
        change: "—",   // Single-observation EIA fetch — no prior-day included
        direction: "flat",
        source: "EIA",
      });
    }
  }

  // ── Market prices: S&P 500, VIX, DXY, BTC ────────────────────────────────
  // Prefer TwelveData; fall back to FMP if only that key is set.
  const twKey  = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;
  if (twKey) {
    const twItems = await fetchTwelveDataSnapshot(twKey);
    items.push(...twItems);
  } else if (fmpKey) {
    const fmpItems = await fetchFmpSnapshot(fmpKey);
    items.push(...fmpItems);
  }

  // ── 2Y Yield (FRED, secondary) ────────────────────────────────────────────
  // Only add if we have room (strip should ideally be 4–6 items)
  if (items.length < 6) {
    try {
      const twoYearObs = await fetchFredSeries("DGS2", 5);
      if (twoYearObs.length >= 2) {
        const latest = parseFloat(twoYearObs[twoYearObs.length - 1]?.value ?? "");
        const prev   = parseFloat(twoYearObs[twoYearObs.length - 2]?.value ?? "");
        if (!isNaN(latest)) {
          const changeBps = !isNaN(prev) ? Math.round((latest - prev) * 100) : 0;
          const changeStr = changeBps === 0 ? "flat" : `${changeBps > 0 ? "+" : ""}${changeBps}bps`;
          items.push({
            label: "2Y Yield",
            value: `${latest.toFixed(2)}%`,
            change: changeStr,
            direction: changeBps > 0 ? "up" : changeBps < 0 ? "down" : "flat",
            source: "FRED",
          });
        }
      }
    } catch {
      // Optional — skip on failure
    }
  }

  return {
    items: items.slice(0, 6),   // Strip shows at most 6 items
    generatedAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
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
  // S&P 500 (SPX), VIX, Dollar Index (DXY), Bitcoin (BTC/USD)
  const labelMap: Record<string, string> = {
    "SPX":     "S&P 500",
    "VIX":     "VIX",
    "DXY":     "DXY",
    "BTC/USD": "BTC",
  };

  try {
    const url = `https://api.twelvedata.com/quote?symbol=SPX,VIX,DXY,BTC/USD&apikey=${apiKey}`;
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
      if (sym === "VIX")     value = price.toFixed(2);
      else if (sym === "BTC/USD") value = `$${Math.round(price).toLocaleString()}`;
      else if (sym === "SPX") value = Math.round(price).toLocaleString();
      else                    value = price.toFixed(2); // DXY

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
