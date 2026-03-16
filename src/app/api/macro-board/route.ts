import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { MacroBoardData, MacroIndicator, RegimeDimensions } from "@/lib/news-types";
import {
  fetchFredSeries,
  fetchWtiCrudePrice,
  BLS_SERIES,
  fetchBlsMultipleSeries,
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
  const kv = getRedisClient();

  if (!kv) {
    // No Redis — generate live (no cache) or return minimal response
    const data = await buildMacroBoard();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  }

  try {

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
  //
  // Indicators included (8 core macro + WTI energy):
  //   1. Fed Funds Rate   5. CPI YoY
  //   2. 10-Year Yield    6. Core CPI YoY
  //   3. 2-Year Yield     7. WTI Crude (key energy/inflation input)
  //   4. Yield Curve      8. Unemployment
  //   9. Nonfarm Payrolls
  //
  // Removed: Bitcoin (not a macro indicator), Brent Crude (redundant with WTI)
  const [fedObs, tenYearObs, twoYearObs, cpiObs, coreCpiObs, wtiObs, blsObs] = await Promise.allSettled([
    fetchFredSeries("DFEDTARU", 3),   // Fed Funds upper target
    fetchFredSeries("DGS10", 3),      // 10-Year Treasury
    fetchFredSeries("DGS2", 3),       // 2-Year Treasury
    fetchFredSeries("CPIAUCSL", 18),  // CPI index — 18 months (extra buffer for missing FRED data points)
    fetchFredSeries("CPILFESL", 18),  // Core CPI index — 18 months (extra buffer for missing FRED data points)
    fetchWtiCrudePrice(),             // WTI crude oil ($/bbl) — primary energy input
    fetchBlsMultipleSeries([BLS_SERIES.NONFARM_PAYROLLS, BLS_SERIES.UNEMPLOYMENT], 1),
  ]);

  const fedData     = fedObs.status      === "fulfilled" ? fedObs.value      : [];
  const tenYearData = tenYearObs.status  === "fulfilled" ? tenYearObs.value  : [];
  const twoYearData = twoYearObs.status  === "fulfilled" ? twoYearObs.value  : [];
  const cpiData     = cpiObs.status      === "fulfilled" ? cpiObs.value      : [];
  const coreCpiData = coreCpiObs.status  === "fulfilled" ? coreCpiObs.value  : [];
  const wtiData     = wtiObs.status      === "fulfilled" ? wtiObs.value      : null;
  const blsRaw      = blsObs.status      === "fulfilled" ? blsObs.value      : {};

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
    const spreadBps = Math.round(spread * 100);
    indicators.push({
      label: "Yield Curve",
      value: `${spreadBps >= 0 ? "+" : ""}${spreadBps} bps`,  // e.g. "+22 bps" instead of "+0.22%"
      change: Math.abs(changeBps) > 0 ? `${changeBps > 0 ? "+" : ""}${changeBps}bps` : undefined,
      direction: spread > prevSpread + 0.01 ? "up" : spread < prevSpread - 0.01 ? "down" : "flat",
      source: "FRED",
      updatedAt: tenYearData[0].date,
    });
  }

  // 5. CPI Year-over-Year
  // Uses date-based matching instead of index offsets to handle missing FRED
  // data points (e.g. Oct 2025 reported as "."). Index-based cpiData[12]
  // fails when filtered observations shift the array, producing stale YoY.
  if (cpiData.length >= 2) {
    const latestDate = new Date(cpiData[0].date);
    const yearAgoTarget = new Date(latestDate);
    yearAgoTarget.setFullYear(yearAgoTarget.getFullYear() - 1);
    const prevMonthTarget = new Date(latestDate);
    prevMonthTarget.setMonth(prevMonthTarget.getMonth() - 1);
    const prevYearAgoTarget = new Date(prevMonthTarget);
    prevYearAgoTarget.setFullYear(prevYearAgoTarget.getFullYear() - 1);

    const yearAgoObs = findClosestObservation(cpiData, yearAgoTarget);
    const prevMonthObs = findClosestObservation(cpiData, prevMonthTarget);
    const prevYearAgoObs = findClosestObservation(cpiData, prevYearAgoTarget);

    if (yearAgoObs) {
      const latest = parseFloat(cpiData[0].value);
      const yearAgo = parseFloat(yearAgoObs.value);
      const yoy = ((latest / yearAgo - 1) * 100);
      let prevYoy = yoy;
      if (prevMonthObs && prevYearAgoObs) {
        prevYoy = ((parseFloat(prevMonthObs.value) / parseFloat(prevYearAgoObs.value) - 1) * 100);
      }
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
  }

  // 6. Core CPI Year-over-Year (ex food & energy)
  if (coreCpiData.length >= 2) {
    const latestDate = new Date(coreCpiData[0].date);
    const yearAgoTarget = new Date(latestDate);
    yearAgoTarget.setFullYear(yearAgoTarget.getFullYear() - 1);
    const prevMonthTarget = new Date(latestDate);
    prevMonthTarget.setMonth(prevMonthTarget.getMonth() - 1);
    const prevYearAgoTarget = new Date(prevMonthTarget);
    prevYearAgoTarget.setFullYear(prevYearAgoTarget.getFullYear() - 1);

    const yearAgoObs = findClosestObservation(coreCpiData, yearAgoTarget);
    const prevMonthObs = findClosestObservation(coreCpiData, prevMonthTarget);
    const prevYearAgoObs = findClosestObservation(coreCpiData, prevYearAgoTarget);

    if (yearAgoObs) {
      const latest = parseFloat(coreCpiData[0].value);
      const yearAgo = parseFloat(yearAgoObs.value);
      const yoy = ((latest / yearAgo - 1) * 100);
      let prevYoy = yoy;
      if (prevMonthObs && prevYearAgoObs) {
        prevYoy = ((parseFloat(prevMonthObs.value) / parseFloat(prevYearAgoObs.value) - 1) * 100);
      }
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

  // ---------------------------------------------------------------------------
  // Regime classification
  // ---------------------------------------------------------------------------
  const regimeTags: string[] = [];

  const fedRate      = indicators.find((i) => i.label === "Fed Funds Rate");
  const cpiYoy       = indicators.find((i) => i.label === "CPI (YoY)");
  const coreCpiYoy   = indicators.find((i) => i.label === "Core CPI (YoY)");
  const wtiInd       = indicators.find((i) => i.label === "WTI Crude");
  const unemployment = indicators.find((i) => i.label === "Unemployment");
  const yieldCurve   = indicators.find((i) => i.label === "Yield Curve");

  if (fedRate) {
    const rate = parseFloat(fedRate.value);
    if (rate > 4.0) regimeTags.push("Policy Restrictive");
    else if (rate < 2.5) regimeTags.push("Policy Accommodative");
    if (fedRate.direction === "down") regimeTags.push("Policy Easing");
    else if (fedRate.direction === "up") regimeTags.push("Policy Tightening");
  }

  // Use Core CPI if available (Fed's preferred inflation signal); fall back to headline CPI
  const inflationIndicator = coreCpiYoy ?? cpiYoy;
  if (inflationIndicator) {
    const cpi = parseFloat(inflationIndicator.value);
    if (cpi > 3.5) regimeTags.push("Inflation Persistent");
    else if (cpi > 2.5 && inflationIndicator.direction !== "down") regimeTags.push("Above-Target Inflation");
    else if (cpi >= 2.0 && inflationIndicator.direction === "down") regimeTags.push("Disinflation Trend");
    else if (cpi < 2.0) regimeTags.push("Inflation Near Target");
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

  // ---------------------------------------------------------------------------
  // Regime dimensions — structured 4-axis snapshot derived from indicator data
  // ---------------------------------------------------------------------------
  const regimeDimensions: RegimeDimensions = {
    inflation: "—",
    policy:    "—",
    growth:    "—",
    liquidity: "—",
  };

  // Inflation dimension
  if (inflationIndicator) {
    const cpi = parseFloat(inflationIndicator.value);
    if (cpi > 3.5)                                            regimeDimensions.inflation = "Persistent";
    else if (cpi > 2.5 && inflationIndicator.direction !== "down") regimeDimensions.inflation = "Above Target";
    else if (cpi >= 2.0 && inflationIndicator.direction === "down") regimeDimensions.inflation = "Disinflating";
    else                                                       regimeDimensions.inflation = "Near Target";
  }

  // Policy dimension
  if (fedRate) {
    const rate = parseFloat(fedRate.value);
    if (fedRate.direction === "down")      regimeDimensions.policy = "Easing";
    else if (fedRate.direction === "up")   regimeDimensions.policy = "Tightening";
    else if (rate > 4.0)                   regimeDimensions.policy = "Restrictive";
    else if (rate < 2.5)                   regimeDimensions.policy = "Accommodative";
    else                                   regimeDimensions.policy = "Neutral";
  }

  // Growth dimension — derived from payrolls + unemployment
  const payrollsInd  = indicators.find((i) => i.label === "Nonfarm Payrolls");
  const unemployInd  = indicators.find((i) => i.label === "Unemployment");
  if (payrollsInd || unemployInd) {
    const payrollsNum = payrollsInd
      ? parseFloat(payrollsInd.value.replace(/[+K,]/g, ""))
      : 200;
    const unemployNum = unemployInd ? parseFloat(unemployInd.value) : 4.0;
    if (payrollsNum > 150 && unemployNum < 4.5)   regimeDimensions.growth = "Solid";
    else if (payrollsNum > 50 || unemployNum < 5.5) regimeDimensions.growth = "Moderating";
    else                                            regimeDimensions.growth = "Slowing";
  }

  // Liquidity dimension — yield curve spread + Fed direction
  if (yieldCurve) {
    const spread = parseFloat(yieldCurve.value.replace(/[+%]/g, ""));
    const isFedEasing = fedRate?.direction === "down";
    if (isFedEasing)            regimeDimensions.liquidity = "Easing";
    else if (spread < -0.25)    regimeDimensions.liquidity = "Tightening";
    else if (spread < 0)        regimeDimensions.liquidity = "Tight";
    else if (spread > 0.5)      regimeDimensions.liquidity = "Accommodative";
    else                        regimeDimensions.liquidity = "Neutral";
  }

  return {
    indicators,
    regime: regimeTags.join(", "),
    regimeTags,
    regimeDimensions,
    generatedAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
  };
}

/**
 * Find the FRED observation closest to a target date.
 * Used for YoY calculations where index-based offsets (e.g. data[12])
 * break when FRED reports missing values (".") that get filtered out.
 * Tolerates up to 45 days of drift to handle missing months gracefully.
 */
function findClosestObservation(
  data: { date: string; value: string }[],
  target: Date
): { date: string; value: string } | null {
  const targetMs = target.getTime();
  let best: { date: string; value: string } | null = null;
  let bestDiff = Infinity;
  for (const obs of data) {
    const diff = Math.abs(new Date(obs.date).getTime() - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = obs;
    }
  }
  // Reject if the closest observation is more than 45 days away
  const MAX_DRIFT_MS = 45 * 24 * 60 * 60 * 1000;
  return best && bestDiff <= MAX_DRIFT_MS ? best : null;
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
