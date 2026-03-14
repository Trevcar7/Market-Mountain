import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MarketSparklinesData, SparklineSet } from "@/lib/news-types";
import { fetchFredSeries } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY        = "market-sparklines";
const CACHE_SECONDS = 15 * 60; // 15 minutes — sparklines don't need sub-minute freshness
const MIN_POINTS    = 5;       // Minimum useful data points for a sparkline

/**
 * GET /api/market-sparklines
 * Returns 30-day daily trendline data for five market indicators:
 *   S&P 500, VIX, WTI Oil, DXY, Bitcoin
 *
 * Sources:
 *   S&P 500      → FRED SP500 (30 daily closes)
 *   VIX          → FRED VIXCLS (30 daily closes)
 *   WTI Oil      → FRED DCOILWTICO (30 daily closes)
 *   DXY          → TwelveData DXY (30 daily) → FRED DTWEXBGS fallback
 *   Bitcoin      → TwelveData BTC/USD (30 daily)
 *
 * TTL: 15-minute server-side Redis cache
 */
export async function GET() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    const data = await buildSparklines();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=60" },
    });
  }

  try {
    const kv     = new Redis({ url, token });
    const cached = await kv.get<MarketSparklinesData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=60" },
      });
    }

    const data = await buildSparklines();
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[/api/market-sparklines] Error:", err);
    const fallback = await buildSparklines().catch(() => emptySparklines());
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

async function buildSparklines(): Promise<MarketSparklinesData> {
  const now        = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  // Fetch all FRED series in parallel — each fails independently
  const [sp500Res, vixRes, wtiRes, dxFredRes] = await Promise.allSettled([
    fetchFredSeries("SP500",      30),
    fetchFredSeries("VIXCLS",     30),
    fetchFredSeries("DCOILWTICO", 30),
    fetchFredSeries("DTWEXBGS",   30), // Fallback for Dollar Index
  ]);

  const sparklines: SparklineSet[] = [];

  // S&P 500
  const sp500Points = fredToChronological(sp500Res.status === "fulfilled" ? sp500Res.value : []);
  if (sp500Points.length >= MIN_POINTS) sparklines.push({ label: "S&P 500", points: sp500Points });

  // VIX
  const vixPoints = fredToChronological(vixRes.status === "fulfilled" ? vixRes.value : []);
  if (vixPoints.length >= MIN_POINTS) sparklines.push({ label: "VIX", points: vixPoints });

  // WTI Oil
  const wtiPoints = fredToChronological(wtiRes.status === "fulfilled" ? wtiRes.value : []);
  if (wtiPoints.length >= MIN_POINTS) sparklines.push({ label: "WTI Oil", points: wtiPoints });

  // Dollar Index + Bitcoin via TwelveData
  const twKey = process.env.TWELVEDATA_API_KEY;
  if (twKey) {
    const [dxySpark, btcSpark] = await Promise.allSettled([
      fetchTwelveDataSeries(twKey, "DXY",    "DXY"),
      fetchTwelveDataSeries(twKey, "BTC/USD", "Bitcoin"),
    ]);

    if (dxySpark.status === "fulfilled" && dxySpark.value) {
      sparklines.push(dxySpark.value);
    } else {
      // FRED DTWEXBGS fallback
      const dxPoints = fredToChronological(dxFredRes.status === "fulfilled" ? dxFredRes.value : []);
      if (dxPoints.length >= MIN_POINTS) sparklines.push({ label: "DXY", points: dxPoints });
    }

    if (btcSpark.status === "fulfilled" && btcSpark.value) {
      sparklines.push(btcSpark.value);
    }
    // No FRED fallback for BTC — omit sparkline rather than show stale data
  } else {
    // No TwelveData key — use FRED DTWEXBGS for Dollar Index; skip BTC
    const dxPoints = fredToChronological(dxFredRes.status === "fulfilled" ? dxFredRes.value : []);
    if (dxPoints.length >= MIN_POINTS) sparklines.push({ label: "DXY", points: dxPoints });
  }

  return {
    sparklines,
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FredObservation { date: string; value: string; }

/** Convert FRED descending obs array to chronological numeric points. */
function fredToChronological(obs: FredObservation[]): number[] {
  return obs
    .slice()
    .reverse()
    .map((o) => parseFloat(o.value))
    .filter((v) => !isNaN(v));
}

interface TwelveDataSeriesResponse {
  values?: Array<{ close: string }>;
  code?:   number;
  message?: string;
}

async function fetchTwelveDataSeries(
  apiKey: string,
  symbol: string,
  label:  string,
): Promise<SparklineSet | null> {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=30&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 900 } }
    );
    if (!res.ok) {
      console.warn(`[market-sparklines/TwelveData] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    const raw = (await res.json()) as TwelveDataSeriesResponse;
    if (raw.code) {
      console.warn(`[market-sparklines/TwelveData] ${symbol}: ${raw.message}`);
      return null;
    }
    if (!raw.values || raw.values.length < MIN_POINTS) return null;

    // TwelveData returns newest-first — reverse to chronological
    const points = raw.values
      .slice()
      .reverse()
      .map((v) => parseFloat(v.close))
      .filter((v) => !isNaN(v));

    return points.length >= MIN_POINTS ? { label, points } : null;
  } catch (err) {
    console.error(`[market-sparklines/TwelveData] ${symbol} error:`, err);
    return null;
  }
}

function emptySparklines(): MarketSparklinesData {
  return {
    sparklines:  [],
    generatedAt: new Date().toISOString(),
    validUntil:  new Date(Date.now() + CACHE_SECONDS * 1000).toISOString(),
  };
}
