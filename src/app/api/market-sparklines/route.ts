import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { MarketSparklinesData, SparklineSet } from "@/lib/news-types";

export const runtime = "nodejs";

const KV_KEY        = "market-sparklines-v2";
const CACHE_SECONDS = 10 * 60; // 10 minutes — intraday sparklines don't need sub-minute freshness
const MIN_POINTS    = 3;       // Lower threshold for intraday (may only have a few bars early in the day)

/**
 * Intraday sparkline configuration.
 * Each entry maps to a TwelveData symbol for 5-min intraday data.
 *
 * These are SHAPE proxies — the sparkline just shows directional trend,
 * not the literal value. ETF proxies are fine for this purpose:
 *   SPY tracks S&P 500 direction, USO tracks WTI crude, etc.
 */
const SPARKLINE_SYMBOLS: Array<{ symbol: string; label: string }> = [
  { symbol: "SPY",     label: "S&P 500" },
  { symbol: "UVXY",    label: "VIX" },       // UVXY = 2× VIX short-term futures — shows VIX direction; free-tier compatible
  { symbol: "USO",     label: "WTI Oil" },
  { symbol: "XAU/USD", label: "Gold" },
  { symbol: "UUP",     label: "Broad U.S. Dollar Index" },
  { symbol: "BTC/USD", label: "Bitcoin" },
];

/**
 * Compute today's 9:30 AM ET market open timestamp.
 * Used to invalidate stale sparkline cache from the previous session.
 *
 * Rule: All sparkline visualizations are session-based.
 * At 9:30 AM ET the cache is force-invalidated so sparklines rebuild with
 * the current trading day's intraday data.
 */
function todayMarketOpenET(): Date {
  const etDate = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const [month, day, year] = etDate.split("/").map(Number);
  const etString = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T09:30:00`;
  const utcNow = new Date();
  const etNow = new Date(utcNow.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offsetMs = utcNow.getTime() - etNow.getTime();
  return new Date(new Date(etString).getTime() + offsetMs);
}

/**
 * GET /api/market-sparklines
 * Returns intraday 5-min trendline data for six market indicators.
 * Data resets at 9:30 AM ET each trading day and builds throughout the session.
 *
 * Sources: TwelveData intraday (5min interval)
 *   S&P 500  → SPY (ETF proxy)
 *   VIX      → VIX index
 *   WTI Oil  → USO (ETF proxy)
 *   Gold     → XAU/USD (forex)
 *   DXY      → UUP (ETF proxy)
 *   Bitcoin   → BTC/USD (crypto, trades 24/7)
 *
 * TTL: 10-min server-side Redis cache (within each session)
 */
export async function GET() {
  const kv = getRedisClient();
  const marketOpen = todayMarketOpenET();

  if (!kv) {
    const data = await buildSparklines();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=60" },
    });
  }

  try {
    const cached = await kv.get<MarketSparklinesData>(KV_KEY);
    const now = new Date();

    // Session-based invalidation: discard cache if it was built before today's
    // 9:30 AM ET market open AND we are now past that open time.
    const cacheIsStale = cached && (
      new Date(cached.validUntil) <= now ||
      (now >= marketOpen && new Date(cached.generatedAt) < marketOpen)
    );

    if (cached && !cacheIsStale) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=60" },
      });
    }

    const data = await buildSparklines();
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[/api/market-sparklines] Error:", err);
    const fallback = await buildSparklines().catch(() => emptySparklines());
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Builder — intraday 5-min data from TwelveData
// ---------------------------------------------------------------------------

async function buildSparklines(): Promise<MarketSparklinesData> {
  const now        = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  const twKey = process.env.TWELVEDATA_API_KEY;
  if (!twKey) {
    console.warn("[market-sparklines] TWELVEDATA_API_KEY not set — no intraday data");
    return { sparklines: [], generatedAt: now.toISOString(), validUntil: validUntil.toISOString() };
  }

  // Fetch in two batches to stay under TwelveData's 8-credits/minute rate limit.
  // Batch 1: 3 symbols, Batch 2: 3 symbols (with brief pause between).
  const batch1Symbols = SPARKLINE_SYMBOLS.slice(0, 3);
  const batch2Symbols = SPARKLINE_SYMBOLS.slice(3);

  const batch1 = await Promise.allSettled(
    batch1Symbols.map(({ symbol, label }) => fetchIntradaySeries(twKey, symbol, label))
  );

  // Brief pause so batch 2 falls into the next rate-limit minute window
  if (batch2Symbols.length > 0) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  const batch2 = await Promise.allSettled(
    batch2Symbols.map(({ symbol, label }) => fetchIntradaySeries(twKey, symbol, label))
  );

  const sparklines: SparklineSet[] = [];
  for (const result of [...batch1, ...batch2]) {
    if (result.status === "fulfilled" && result.value) {
      sparklines.push(result.value);
    }
  }

  return {
    sparklines,
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData intraday time_series fetch
// ---------------------------------------------------------------------------

interface TwelveDataBar {
  datetime: string;
  close:    string;
}

interface TwelveDataTimeSeriesResponse {
  values?:  TwelveDataBar[];
  code?:    number;
  message?: string;
}

async function fetchIntradaySeries(
  apiKey: string,
  symbol: string,
  label: string,
): Promise<SparklineSet | null> {
  try {
    // Request 78 bars of 5-min data per symbol.
    // TwelveData free tier caps intraday history for equity ETFs to ~20 bars
    // regardless of outputsize; forex/crypto (XAU/USD, BTC/USD) return up to 78.
    // Larger values cause response-size timeouts for 24/7 instruments.
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=78&apikey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), cache: "no-store" });

    if (!res.ok) {
      console.warn(`[market-sparklines] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const raw = (await res.json()) as TwelveDataTimeSeriesResponse;
    if (raw.code) {
      console.warn(`[market-sparklines] ${symbol}: ${raw.message}`);
      return null;
    }
    if (!raw.values || raw.values.length < MIN_POINTS) return null;

    // TwelveData returns newest-first. Group by date, keep only the latest
    // trading session so sparklines show today's intraday action.
    const latestDate = raw.values[0].datetime.split(" ")[0];
    const sessionBars = raw.values.filter((v) => v.datetime.startsWith(latestDate));

    // Reverse to chronological order (oldest bar first → newest last)
    const points = sessionBars
      .slice()
      .reverse()
      .map((v) => parseFloat(v.close))
      .filter((v) => !isNaN(v));

    return points.length >= MIN_POINTS ? { label, points } : null;
  } catch (err) {
    console.error(`[market-sparklines] ${symbol} error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Empty fallback
// ---------------------------------------------------------------------------

function emptySparklines(): MarketSparklinesData {
  return {
    sparklines:  [],
    generatedAt: new Date().toISOString(),
    validUntil:  new Date(Date.now() + CACHE_SECONDS * 1000).toISOString(),
  };
}
