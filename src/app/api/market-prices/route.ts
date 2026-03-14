import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MarketSnapshotItem, MarketPricesData } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-prices";
const CACHE_SECONDS = 60;

/**
 * GET /api/market-prices
 * Returns five Market Prices indicators for the homepage MacroBoard:
 *   S&P 500, VIX, WTI Oil, Dollar Index, Bitcoin
 *
 * Data sources (all graceful-degrade, fetched in parallel):
 *   - FRED:        S&P 500 (SP500), VIX (VIXCLS) — daily close, "Daily Close" label
 *   - EIA:         WTI crude oil spot price
 *   - TwelveData:  Dollar Index (DXY), Bitcoin (BTC/USD) — real-time
 *   - FMP:         DXY + BTC fallback when TwelveData unavailable
 *
 * Returns session metadata (sessionStatus, refreshIntervalMs) so the client
 * can apply smart refresh intervals: 60s during market hours, 5min otherwise.
 *
 * TTL: 60s server-side Redis cache
 */
export async function GET() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  const session = getMarketSession();

  if (!url || !token) {
    const data = await buildPrices(session);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
    });
  }

  try {
    const kv = new Redis({ url, token });

    const cached = await kv.get<MarketPricesData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      // Always return fresh session metadata — it's time-dependent, not data-dependent
      return NextResponse.json(
        { ...cached, sessionStatus: session.status, refreshIntervalMs: session.refreshMs },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } }
      );
    }

    const data = await buildPrices(session);
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
    });
  } catch (err) {
    console.error("[/api/market-prices] Error:", err);
    const fallback = await buildPrices(session).catch(() => emptyPrices(session));
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Trading session detection (US Eastern Time)
// ---------------------------------------------------------------------------

function getMarketSession(): { status: "open" | "extended" | "closed"; refreshMs: number } {
  // Use locale conversion for a DST-aware ET time
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const day = etNow.getDay(); // 0=Sun, 6=Sat
  const tm  = etNow.getHours() * 60 + etNow.getMinutes();

  // Weekdays only
  if (day >= 1 && day <= 5) {
    if (tm >= 9 * 60 + 30 && tm < 16 * 60)   return { status: "open",     refreshMs: 60_000 };
    if (tm >= 16 * 60       && tm < 20 * 60)  return { status: "extended", refreshMs: 5 * 60_000 };
  }

  // Weekend or outside trading hours — still refresh every 5min for BTC
  return { status: "closed", refreshMs: 5 * 60_000 };
}

// ---------------------------------------------------------------------------
// Price builder — collects all five items in parallel
// ---------------------------------------------------------------------------

async function buildPrices(
  session: { status: "open" | "extended" | "closed"; refreshMs: number }
): Promise<MarketPricesData> {
  const now      = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  // FRED baseline for S&P 500 + VIX (daily close, 1-day delayed)
  // fetchFredSeries returns descending observations — [0] is most recent
  const [sp500Res, vixRes, wtiRes] = await Promise.allSettled([
    fetchFredSeries("SP500",  3),
    fetchFredSeries("VIXCLS", 3),
    fetchWtiCrudePrice(),
  ]);

  const itemMap = new Map<string, MarketSnapshotItem>();

  // ── S&P 500 (FRED daily close) ────────────────────────────────────────────
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
        source:    "Daily Close",
      });
    }
  }

  // ── VIX (FRED daily close) — show percentage change ──────────────────────
  const vixObs = vixRes.status === "fulfilled" ? vixRes.value : [];
  if (vixObs.length >= 1) {
    const latest = parseFloat(vixObs[0].value);
    const prev   = vixObs.length >= 2 ? parseFloat(vixObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("VIX", {
        label:     "VIX",
        value:     latest.toFixed(2),
        change:    Math.abs(pct) < 0.05 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat",
        source:    "Daily Close",
      });
    }
  }

  // ── WTI Crude Oil (EIA) ───────────────────────────────────────────────────
  if (wtiRes.status === "fulfilled" && wtiRes.value && typeof wtiRes.value.value === "number") {
    itemMap.set("WTI Oil", {
      label:     "WTI Oil",
      value:     `$${wtiRes.value.value.toFixed(2)}`,
      change:    "—",
      direction: "flat",
      source:    "EIA",
    });
  }

  // ── TwelveData: Dollar Index (DXY) + Bitcoin (BTC/USD) ───────────────────
  const twKey  = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  if (twKey) {
    for (const item of await fetchTwelveDataPrices(twKey)) {
      itemMap.set(item.label, item);
    }
  } else if (fmpKey) {
    for (const item of await fetchFmpPrices(fmpKey)) {
      itemMap.set(item.label, item);
    }
  }

  // ── Output in display order ───────────────────────────────────────────────
  const ORDER = ["S&P 500", "VIX", "WTI Oil", "Dollar Index", "Bitcoin"];
  const items = ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  return {
    items: items.slice(0, 5),
    sessionStatus:    session.status,
    refreshIntervalMs: session.refreshMs,
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData — Dollar Index + Bitcoin (free-plan supported)
// ---------------------------------------------------------------------------

interface TwelveDataQuote {
  close?:           string;
  percent_change?:  string;
  code?:            number;
  message?:         string;
}

async function fetchTwelveDataPrices(apiKey: string): Promise<MarketSnapshotItem[]> {
  const labelMap: Record<string, string> = {
    "DXY":     "Dollar Index",
    "BTC/USD": "Bitcoin",
  };

  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=DXY,BTC/USD&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 60 } }
    );
    if (!res.ok) {
      console.warn(`[market-prices/TwelveData] HTTP ${res.status}`);
      return [];
    }

    const raw = (await res.json()) as Record<string, TwelveDataQuote>;
    const result: MarketSnapshotItem[] = [];

    for (const [sym, quote] of Object.entries(raw)) {
      if (!quote || quote.code || !quote.close) {
        if (quote?.code) console.warn(`[market-prices/TwelveData] ${sym}: ${quote.message}`);
        continue;
      }

      const price = parseFloat(quote.close);
      if (isNaN(price)) continue;

      const pct   = parseFloat(quote.percent_change ?? "0");
      const label = labelMap[sym];
      if (!label) continue;

      const value = sym === "BTC/USD"
        ? `$${Math.round(price).toLocaleString()}`
        : price.toFixed(2); // DXY

      result.push({
        label,
        value,
        change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
        source:    "TwelveData",
      });
    }

    return result;
  } catch (err) {
    console.error("[market-prices/TwelveData] fetch error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// FMP (Financial Modeling Prep) — fallback for DXY + BTC
// ---------------------------------------------------------------------------

interface FmpQuote {
  symbol:           string;
  price:            number;
  changesPercentage: number;
}

async function fetchFmpPrices(apiKey: string): Promise<MarketSnapshotItem[]> {
  try {
    const res = await fetch(
      `https://financialmodelingprep.com/api/v3/quote/DX-Y.NYB,BTCUSD?apikey=${apiKey}`,
      { next: { revalidate: 60 } }
    );
    if (!res.ok) return [];

    const quotes = (await res.json()) as FmpQuote[];

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
