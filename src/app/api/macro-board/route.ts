import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MacroBoardData, MacroIndicator } from "@/lib/news-types";
import {
  fetchFredSeries,
  fetchWtiCrudePrice,
  BLS_SERIES,
  fetchBlsMacroSummary,
} from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "macro-board";
const CACHE_SECONDS = 900; // 15-minute Redis TTL

/**
 * GET /api/macro-board
 * Returns live macro indicators and a regime classification.
 * Cached in Redis for 15 minutes; falls back to 200 with empty indicators.
 */
export async function GET() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    // No Redis — generate live (no cache) or return minimal response
    const data = await buildMacroBoard();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  }

  try {
    const kv = new Redis({ url, token });

    // Serve from cache if still valid
    const cached = await kv.get<MacroBoardData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
      });
    }

    // Build fresh data
    const data = await buildMacroBoard();

    // Cache for 15 minutes
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (error) {
    console.error("[/api/macro-board] Error:", error);
    // Return minimal data rather than 500 — board should always render
    const fallback = await buildMacroBoard().catch(() => emptyBoard());
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Board builder
// ---------------------------------------------------------------------------

async function buildMacroBoard(): Promise<MacroBoardData> {
  const now = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  // Fetch all indicators in parallel — each gracefully degrades to null on failure
  const [fedObs, tenYearObs, cpiObs, wti, bls] = await Promise.allSettled([
    fetchFredSeries("DFEDTARU", 3),   // Fed Funds upper target (last 3 for trend)
    fetchFredSeries("DGS10", 3),      // 10-Year Treasury (last 3 for trend)
    fetchFredSeries("CPIAUCSL", 14),  // CPI index — 14 months to compute YoY + direction
    fetchWtiCrudePrice(),             // WTI crude oil ($/bbl)
    fetchBlsMacroSummary(),           // Unemployment, payrolls, wages
  ]);

  const fedData    = fedObs.status      === "fulfilled" ? fedObs.value      : [];
  const tenYearData = tenYearObs.status === "fulfilled" ? tenYearObs.value  : [];
  const cpiData    = cpiObs.status      === "fulfilled" ? cpiObs.value      : [];
  const wtiData    = wti.status         === "fulfilled" ? wti.value         : null;
  const blsData    = bls.status         === "fulfilled" ? bls.value         : {
    cpi: null, unemployment: null, payrolls: null, wages: null,
  };

  const indicators: MacroIndicator[] = [];

  // 1. Fed Funds Rate
  if (fedData.length > 0) {
    const current = parseFloat(fedData[0].value);
    const previous = fedData.length > 1 ? parseFloat(fedData[1].value) : current;
    indicators.push({
      label: "Fed Funds Rate",
      value: `${current.toFixed(2)}%`,
      change: current !== previous ? `${current > previous ? "+" : ""}${(current - previous).toFixed(2)}%` : undefined,
      direction: current > previous ? "up" : current < previous ? "down" : "flat",
      source: "FRED",
      updatedAt: fedData[0].date,
    });
  }

  // 2. 10-Year Treasury Yield
  if (tenYearData.length > 0) {
    const current = parseFloat(tenYearData[0].value);
    const previous = tenYearData.length > 1 ? parseFloat(tenYearData[1].value) : current;
    const changeBps = Math.round((current - previous) * 100);
    indicators.push({
      label: "10-Year Yield",
      value: `${current.toFixed(2)}%`,
      change: changeBps !== 0 ? `${changeBps > 0 ? "+" : ""}${changeBps}bps` : undefined,
      direction: current > previous ? "up" : current < previous ? "down" : "flat",
      source: "FRED",
      updatedAt: tenYearData[0].date,
    });
  }

  // 3. CPI Year-over-Year
  if (cpiData.length >= 13) {
    const latest = parseFloat(cpiData[0].value);
    const yearAgo = parseFloat(cpiData[12].value);
    const yoy = ((latest / yearAgo - 1) * 100);

    // Direction: compare last month's YoY to this month's YoY
    const prevMonthLatest = cpiData.length >= 14 ? parseFloat(cpiData[1].value) : latest;
    const prevMonthYearAgo = cpiData.length >= 14 ? parseFloat(cpiData[13].value) : yearAgo;
    const prevYoy = cpiData.length >= 14 ? ((prevMonthLatest / prevMonthYearAgo - 1) * 100) : yoy;

    indicators.push({
      label: "CPI (YoY)",
      value: `${yoy.toFixed(1)}%`,
      change: Math.abs(yoy - prevYoy) > 0.05
        ? `${yoy > prevYoy ? "+" : ""}${(yoy - prevYoy).toFixed(1)}%`
        : undefined,
      direction: yoy > prevYoy + 0.05 ? "up" : yoy < prevYoy - 0.05 ? "down" : "flat",
      source: "FRED",
      updatedAt: cpiData[0].date,
    });
  }

  // 4. WTI Crude Oil
  if (wtiData) {
    indicators.push({
      label: "WTI Crude",
      value: `$${wtiData.value.toFixed(2)}`,
      direction: "flat", // Single point — direction unknown without prior
      source: "EIA",
      updatedAt: wtiData.period,
    });
  }

  // 5. Unemployment Rate (from BLS)
  if (blsData.unemployment) {
    const val = parseFloat(blsData.unemployment.value);
    indicators.push({
      label: "Unemployment",
      value: `${val.toFixed(1)}%`,
      direction: val < 4.0 ? "down" : val > 5.0 ? "up" : "flat", // Lower = tighter labor market
      source: "BLS",
      updatedAt: blsData.unemployment.period,
    });
  }

  // 6. Nonfarm Payrolls (monthly change)
  if (blsData.payrolls) {
    const val = parseFloat(blsData.payrolls.value);
    indicators.push({
      label: "Nonfarm Payrolls",
      value: `${val >= 0 ? "+" : ""}${Math.round(val).toLocaleString()}K`,
      direction: val > 150 ? "up" : val < 50 ? "down" : "flat",
      source: "BLS",
      updatedAt: blsData.payrolls.period,
    });
  }

  // ---------------------------------------------------------------------------
  // Regime classification
  // ---------------------------------------------------------------------------
  const regimeTags: string[] = [];

  const fedRate = indicators.find((i) => i.label === "Fed Funds Rate");
  const cpiYoy = indicators.find((i) => i.label === "CPI (YoY)");
  const wtiIndicator = indicators.find((i) => i.label === "WTI Crude");
  const unemployment = indicators.find((i) => i.label === "Unemployment");

  if (fedRate) {
    const rate = parseFloat(fedRate.value);
    if (rate > 4.0) regimeTags.push("Policy Restrictive");
    else if (rate < 2.5) regimeTags.push("Policy Accommodative");
    if (fedRate.direction === "down") regimeTags.push("Policy Easing");
    else if (fedRate.direction === "up") regimeTags.push("Policy Tightening");
  }

  if (cpiYoy) {
    const cpi = parseFloat(cpiYoy.value);
    if (cpi > 3.5) regimeTags.push("Inflation Persistent");
    else if (cpi < 2.5 && cpiYoy.direction === "down") regimeTags.push("Disinflation Trend");
    else if (cpi >= 2.0 && cpi <= 3.5 && cpiYoy.direction === "down") regimeTags.push("Disinflation Trend");
  }

  if (wtiIndicator) {
    const price = parseFloat(wtiIndicator.value.replace("$", ""));
    if (price > 90) regimeTags.push("Energy Shock Active");
    else if (price < 60) regimeTags.push("Energy Deflationary");
  }

  if (unemployment) {
    const rate = parseFloat(unemployment.value);
    if (rate < 4.0) regimeTags.push("Labor Market Tight");
    else if (rate > 5.5) regimeTags.push("Labor Market Cooling");
  }

  if (regimeTags.length === 0) regimeTags.push("Monitoring Mode");

  return {
    indicators,
    regime: regimeTags.join(", "),
    regimeTags,
    generatedAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
  };
}

function emptyBoard(): MacroBoardData {
  const now = new Date();
  return {
    indicators: [],
    regime: "Data Unavailable",
    regimeTags: ["Data Unavailable"],
    generatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 60000).toISOString(),
  };
}
