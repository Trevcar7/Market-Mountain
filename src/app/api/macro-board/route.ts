import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MacroBoardData, MacroIndicator } from "@/lib/news-types";
import {
  fetchFredSeries,
  fetchWtiCrudePrice,
  fetchBrentCrudePrice,
  BLS_SERIES,
  fetchBlsMultipleSeries,
  fetchBitcoinPrice,
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

  // Fetch all indicators in parallel — each gracefully degrades on failure
  const [fedObs, tenYearObs, twoYearObs, cpiObs, coreCpiObs, wti, brent, blsObs, btcObs] = await Promise.allSettled([
    fetchFredSeries("DFEDTARU", 3),   // Fed Funds upper target
    fetchFredSeries("DGS10", 3),      // 10-Year Treasury
    fetchFredSeries("DGS2", 3),       // 2-Year Treasury
    fetchFredSeries("CPIAUCSL", 14),  // CPI index — 14 months for YoY
    fetchFredSeries("CPILFESL", 14),  // Core CPI index — 14 months for YoY
    fetchWtiCrudePrice(),             // WTI crude oil ($/bbl)
    fetchBrentCrudePrice(),           // Brent crude oil ($/bbl)
    fetchBlsMultipleSeries([BLS_SERIES.NONFARM_PAYROLLS, BLS_SERIES.UNEMPLOYMENT], 1),
    fetchBitcoinPrice(),              // Bitcoin price (USD)
  ]);

  const fedData     = fedObs.status      === "fulfilled" ? fedObs.value      : [];
  const tenYearData = tenYearObs.status  === "fulfilled" ? tenYearObs.value  : [];
  const twoYearData = twoYearObs.status  === "fulfilled" ? twoYearObs.value  : [];
  const cpiData     = cpiObs.status      === "fulfilled" ? cpiObs.value      : [];
  const coreCpiData = coreCpiObs.status  === "fulfilled" ? coreCpiObs.value  : [];
  const wtiData     = wti.status         === "fulfilled" ? wti.value         : null;
  const brentData   = brent.status       === "fulfilled" ? brent.value       : null;
  const blsRaw      = blsObs.status      === "fulfilled" ? blsObs.value      : {};
  const btcData     = btcObs.status      === "fulfilled" ? btcObs.value      : null;

  const payrollsArr = blsRaw[BLS_SERIES.NONFARM_PAYROLLS] ?? [];
  const unemployArr = blsRaw[BLS_SERIES.UNEMPLOYMENT]     ?? [];

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

  // 3. 2-Year Treasury Yield
  if (twoYearData.length > 0) {
    const current = parseFloat(twoYearData[0].value);
    const previous = twoYearData.length > 1 ? parseFloat(twoYearData[1].value) : current;
    const changeBps = Math.round((current - previous) * 100);
    indicators.push({
      label: "2-Year Yield",
      value: `${current.toFixed(2)}%`,
      change: changeBps !== 0 ? `${changeBps > 0 ? "+" : ""}${changeBps}bps` : undefined,
      direction: current > previous ? "up" : current < previous ? "down" : "flat",
      source: "FRED",
      updatedAt: twoYearData[0].date,
    });
  }

  // 4. Yield Curve (10Y – 2Y spread)
  if (tenYearData.length > 0 && twoYearData.length > 0) {
    const ten = parseFloat(tenYearData[0].value);
    const two = parseFloat(twoYearData[0].value);
    const spread = ten - two;
    const prevTen = tenYearData.length > 1 ? parseFloat(tenYearData[1].value) : ten;
    const prevTwo = twoYearData.length > 1 ? parseFloat(twoYearData[1].value) : two;
    const prevSpread = prevTen - prevTwo;
    const changeBps = Math.round((spread - prevSpread) * 100);
    indicators.push({
      label: "Yield Curve",
      value: `${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`,
      change: Math.abs(changeBps) > 0 ? `${changeBps > 0 ? "+" : ""}${changeBps}bps` : undefined,
      direction: spread > prevSpread + 0.01 ? "up" : spread < prevSpread - 0.01 ? "down" : "flat",
      source: "FRED",
      updatedAt: tenYearData[0].date,
    });
  }

  // 5. CPI Year-over-Year
  if (cpiData.length >= 13) {
    const latest = parseFloat(cpiData[0].value);
    const yearAgo = parseFloat(cpiData[12].value);
    const yoy = ((latest / yearAgo - 1) * 100);
    const prevMonthLatest  = cpiData.length >= 14 ? parseFloat(cpiData[1].value)  : latest;
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

  // 6. Core CPI Year-over-Year (ex food & energy)
  if (coreCpiData.length >= 13) {
    const latest = parseFloat(coreCpiData[0].value);
    const yearAgo = parseFloat(coreCpiData[12].value);
    const yoy = ((latest / yearAgo - 1) * 100);
    const prevMonthLatest  = coreCpiData.length >= 14 ? parseFloat(coreCpiData[1].value)  : latest;
    const prevMonthYearAgo = coreCpiData.length >= 14 ? parseFloat(coreCpiData[13].value) : yearAgo;
    const prevYoy = coreCpiData.length >= 14 ? ((prevMonthLatest / prevMonthYearAgo - 1) * 100) : yoy;
    indicators.push({
      label: "Core CPI (YoY)",
      value: `${yoy.toFixed(1)}%`,
      change: Math.abs(yoy - prevYoy) > 0.05
        ? `${yoy > prevYoy ? "+" : ""}${(yoy - prevYoy).toFixed(1)}%`
        : undefined,
      direction: yoy > prevYoy + 0.05 ? "up" : yoy < prevYoy - 0.05 ? "down" : "flat",
      source: "FRED",
      updatedAt: coreCpiData[0].date,
    });
  }

  // 7. WTI Crude Oil
  if (wtiData) {
    indicators.push({
      label: "WTI Crude",
      value: `$${wtiData.value.toFixed(2)}`,
      direction: "flat",
      source: "EIA",
      updatedAt: wtiData.period,
    });
  }

  // 8. Brent Crude Oil
  if (brentData) {
    indicators.push({
      label: "Brent Crude",
      value: `$${brentData.value.toFixed(2)}`,
      direction: "flat",
      source: "EIA",
      updatedAt: brentData.period,
    });
  }

  // 9. Unemployment Rate
  if (unemployArr.length > 0) {
    const val = parseFloat(unemployArr[0].value);
    indicators.push({
      label: "Unemployment",
      value: `${val.toFixed(1)}%`,
      direction: val < 4.0 ? "down" : val > 5.0 ? "up" : "flat",
      source: "BLS",
      updatedAt: `${unemployArr[0].periodName} ${unemployArr[0].year}`,
    });
  }

  // 10. Nonfarm Payrolls — monthly change (BLS values are in thousands)
  if (payrollsArr.length >= 2) {
    const current  = parseFloat(payrollsArr[0].value);
    const previous = parseFloat(payrollsArr[1].value);
    const monthlyChange = Math.round(current - previous);
    indicators.push({
      label: "Nonfarm Payrolls",
      value: `${monthlyChange >= 0 ? "+" : ""}${monthlyChange.toLocaleString()}K`,
      direction: monthlyChange > 150 ? "up" : monthlyChange < 50 ? "down" : "flat",
      source: "BLS",
      updatedAt: `${payrollsArr[0].periodName} ${payrollsArr[0].year}`,
    });
  }

  // 11. Bitcoin Price
  if (btcData) {
    const priceStr = btcData.price >= 1000
      ? `$${(btcData.price / 1000).toFixed(1)}K`
      : `$${btcData.price.toFixed(0)}`;
    indicators.push({
      label: "Bitcoin",
      value: priceStr,
      direction: "flat",
      source: "AV",
      updatedAt: btcData.updatedAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Regime classification
  // ---------------------------------------------------------------------------
  const regimeTags: string[] = [];

  const fedRate    = indicators.find((i) => i.label === "Fed Funds Rate");
  const cpiYoy     = indicators.find((i) => i.label === "CPI (YoY)");
  const wtiInd     = indicators.find((i) => i.label === "WTI Crude");
  const unemployment = indicators.find((i) => i.label === "Unemployment");
  const yieldCurve = indicators.find((i) => i.label === "Yield Curve");

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
    else if (cpi >= 2.0 && cpiYoy.direction === "down") regimeTags.push("Disinflation Trend");
  }

  if (wtiInd) {
    const price = parseFloat(wtiInd.value.replace("$", ""));
    if (price > 90) regimeTags.push("Energy Shock Active");
    else if (price < 60) regimeTags.push("Energy Deflationary");
  }

  if (unemployment) {
    const rate = parseFloat(unemployment.value);
    if (rate < 4.0) regimeTags.push("Labor Market Tight");
    else if (rate > 5.5) regimeTags.push("Labor Market Cooling");
  }

  if (yieldCurve) {
    const spread = parseFloat(yieldCurve.value.replace("%", ""));
    if (spread < -0.25) regimeTags.push("Yield Curve Inverted");
    else if (spread < 0) regimeTags.push("Curve Flattening");
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
