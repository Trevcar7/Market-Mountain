/**
 * Shared macro board indicator builder.
 * Used by both /api/macro-board and /api/briefing-macro so the briefing
 * page's Macro Snapshot always shows the exact same data as the homepage
 * MacroBoard.
 *
 * Data source priority:
 *   Treasury yields → FMP /api/v4/treasury (real-time) → FRED DGS10/DGS2 (daily close, 1-day lag)
 *   Fed Funds Rate  → FRED DFEDTARU (changes rarely, daily is fine)
 *   CPI / Core CPI  → FRED CPIAUCSL / CPILFESL (monthly, no real-time alternative)
 *   WTI Crude       → EIA primary → FRED fallback
 *   Unemployment    → BLS (monthly)
 *   Nonfarm Payrolls→ BLS (monthly)
 */

import {
  fetchFredSeries,
  fetchWtiCrudePrice,
  BLS_SERIES,
  fetchBlsMultipleSeries,
} from "@/lib/market-data";
import type { MacroIndicator } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// FMP Treasury Rates
// ---------------------------------------------------------------------------

interface FmpTreasuryRow {
  date:    string;
  month1?: number;
  month2?: number;
  month3?: number;
  month6?: number;
  year1?:  number;
  year2?:  number;
  year5?:  number;
  year7?:  number;
  year10?: number;
  year20?: number;
  year30?: number;
}

/**
 * Fetch the latest treasury rates from FMP.
 * Returns the 2 most recent trading days (current + previous for change calc).
 * Single API call — covers all maturities.
 */
async function fetchFmpTreasuryRates(): Promise<FmpTreasuryRow[]> {
  const fmpKey = process.env.FMP_API_KEY;
  if (!fmpKey) return [];

  try {
    // Fetch last 7 days to guarantee at least 2 trading days (accounts for weekends/holidays)
    const to   = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fmt  = (d: Date) => d.toISOString().split("T")[0];

    const res = await fetch(
      `https://financialmodelingprep.com/api/v4/treasury?from=${fmt(from)}&to=${fmt(to)}&apikey=${fmpKey}`,
      { signal: AbortSignal.timeout(8000), cache: "no-store" }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[macro-board] FMP treasury: HTTP ${res.status} — ${body.slice(0, 200)}`);
      return [];
    }

    const data = (await res.json()) as FmpTreasuryRow[];
    if (!Array.isArray(data)) return [];

    // FMP returns newest first — take first 2 entries
    return data.slice(0, 2);
  } catch (err) {
    console.warn(`[macro-board] FMP treasury fetch failed: ${String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Fetch and compute all macro indicators.
 * Each source gracefully degrades to an empty result on failure.
 */
export async function buildMacroBoardIndicators(): Promise<MacroIndicator[]> {
  // Fetch all data sources in parallel
  const [fedObs, tenYearObs, twoYearObs, cpiObs, coreCpiObs, wtiObs, blsObs, fmpTreasury] =
    await Promise.allSettled([
      fetchFredSeries("DFEDTARU", 3),
      fetchFredSeries("DGS10", 3),
      fetchFredSeries("DGS2", 3),
      fetchFredSeries("CPIAUCSL", 18),
      fetchFredSeries("CPILFESL", 18),
      fetchWtiCrudePrice(),
      fetchBlsMultipleSeries(
        [BLS_SERIES.NONFARM_PAYROLLS, BLS_SERIES.UNEMPLOYMENT],
        1
      ),
      fetchFmpTreasuryRates(),
    ]);

  const fedData     = fedObs.status     === "fulfilled" ? fedObs.value     : [];
  const tenYearData = tenYearObs.status === "fulfilled" ? tenYearObs.value : [];
  const twoYearData = twoYearObs.status === "fulfilled" ? twoYearObs.value : [];
  const cpiData     = cpiObs.status     === "fulfilled" ? cpiObs.value     : [];
  const coreCpiData = coreCpiObs.status === "fulfilled" ? coreCpiObs.value : [];
  const wtiData     = wtiObs.status     === "fulfilled" ? wtiObs.value     : null;
  const blsRaw      = blsObs.status     === "fulfilled" ? blsObs.value     : {};
  const treasuryRows = fmpTreasury.status === "fulfilled" ? fmpTreasury.value : [];

  const payrollsArr = blsRaw[BLS_SERIES.NONFARM_PAYROLLS] ?? [];
  const unemployArr = blsRaw[BLS_SERIES.UNEMPLOYMENT]     ?? [];

  const indicators: MacroIndicator[] = [];

  // ---------------------------------------------------------------------------
  // Resolve 10Y and 2Y yields — FMP primary, FRED fallback
  // ---------------------------------------------------------------------------
  let tenYearCurrent:  number | null = null;
  let tenYearPrevious: number | null = null;
  let twoYearCurrent:  number | null = null;
  let twoYearPrevious: number | null = null;
  let yieldSource  = "FRED";
  let yieldDateStr = "";

  // Try FMP treasury rates first (real-time, intraday)
  if (treasuryRows.length >= 1 && treasuryRows[0].year10 != null && treasuryRows[0].year2 != null) {
    tenYearCurrent  = treasuryRows[0].year10;
    twoYearCurrent  = treasuryRows[0].year2;
    yieldSource     = "FMP";
    yieldDateStr    = treasuryRows[0].date;

    if (treasuryRows.length >= 2 && treasuryRows[1].year10 != null && treasuryRows[1].year2 != null) {
      tenYearPrevious = treasuryRows[1].year10;
      twoYearPrevious = treasuryRows[1].year2;
    }
  }

  // Fallback to FRED DGS10 / DGS2
  if (tenYearCurrent === null && tenYearData.length > 0) {
    tenYearCurrent  = parseFloat(tenYearData[0].value);
    tenYearPrevious = tenYearData.length > 1 ? parseFloat(tenYearData[1].value) : null;
    yieldDateStr    = tenYearData[0].date;
    if (isNaN(tenYearCurrent)) tenYearCurrent = null;
  }
  if (twoYearCurrent === null && twoYearData.length > 0) {
    twoYearCurrent  = parseFloat(twoYearData[0].value);
    twoYearPrevious = twoYearData.length > 1 ? parseFloat(twoYearData[1].value) : null;
    if (isNaN(twoYearCurrent)) twoYearCurrent = null;
  }

  // 1. Fed Funds Rate
  if (fedData.length > 0) {
    const current  = parseFloat(fedData[0].value);
    const previous = fedData.length > 1 ? parseFloat(fedData[1].value) : current;
    indicators.push({
      label: "Fed Funds Rate",
      value: `${current.toFixed(2)}%`,
      change: current !== previous
        ? `${current > previous ? "+" : ""}${(current - previous).toFixed(2)}%`
        : undefined,
      direction: current > previous ? "up" : current < previous ? "down" : "flat",
      source: "FRED",
      updatedAt: fedData[0].date,
    });
  }

  // 2. 10-Year Treasury Yield
  if (tenYearCurrent !== null) {
    const prev = tenYearPrevious ?? tenYearCurrent;
    const changeBps = Math.round((tenYearCurrent - prev) * 100);
    indicators.push({
      label: "10-Year Yield",
      value: `${tenYearCurrent.toFixed(2)}%`,
      change: changeBps !== 0
        ? `${changeBps > 0 ? "+" : ""}${changeBps}bps`
        : undefined,
      direction: tenYearCurrent > prev ? "up" : tenYearCurrent < prev ? "down" : "flat",
      source: yieldSource,
      updatedAt: yieldDateStr,
    });
  }

  // 3. 2-Year Treasury Yield
  if (twoYearCurrent !== null) {
    const prev = twoYearPrevious ?? twoYearCurrent;
    const changeBps = Math.round((twoYearCurrent - prev) * 100);
    indicators.push({
      label: "2-Year Yield",
      value: `${twoYearCurrent.toFixed(2)}%`,
      change: changeBps !== 0
        ? `${changeBps > 0 ? "+" : ""}${changeBps}bps`
        : undefined,
      direction: twoYearCurrent > prev ? "up" : twoYearCurrent < prev ? "down" : "flat",
      source: yieldSource,
      updatedAt: yieldDateStr,
    });
  }

  // 4. Yield Curve (10Y – 2Y spread)
  if (tenYearCurrent !== null && twoYearCurrent !== null) {
    const spread   = tenYearCurrent - twoYearCurrent;
    const prevTen  = tenYearPrevious ?? tenYearCurrent;
    const prevTwo  = twoYearPrevious ?? twoYearCurrent;
    const prevSpread  = prevTen - prevTwo;
    const changeBps   = Math.round((spread - prevSpread) * 100);
    const spreadBps   = Math.round(spread * 100);
    indicators.push({
      label: "Yield Curve",
      value: `${spreadBps >= 0 ? "+" : ""}${spreadBps} bps`,
      change: Math.abs(changeBps) > 0
        ? `${changeBps > 0 ? "+" : ""}${changeBps}bps`
        : undefined,
      direction:
        spread > prevSpread + 0.01 ? "up" :
        spread < prevSpread - 0.01 ? "down" : "flat",
      source: yieldSource,
      updatedAt: yieldDateStr,
    });
  }

  // 5. CPI Year-over-Year
  if (cpiData.length >= 2) {
    const latestDate       = new Date(cpiData[0].date);
    const yearAgoTarget    = new Date(latestDate);
    yearAgoTarget.setFullYear(yearAgoTarget.getFullYear() - 1);
    const prevMonthTarget  = new Date(latestDate);
    prevMonthTarget.setMonth(prevMonthTarget.getMonth() - 1);
    const prevYearAgoTarget = new Date(prevMonthTarget);
    prevYearAgoTarget.setFullYear(prevYearAgoTarget.getFullYear() - 1);

    const yearAgoObs     = findClosestObservation(cpiData, yearAgoTarget);
    const prevMonthObs   = findClosestObservation(cpiData, prevMonthTarget);
    const prevYearAgoObs = findClosestObservation(cpiData, prevYearAgoTarget);

    if (yearAgoObs) {
      const latest  = parseFloat(cpiData[0].value);
      const yearAgo = parseFloat(yearAgoObs.value);
      const yoy     = (latest / yearAgo - 1) * 100;
      let prevYoy   = yoy;
      if (prevMonthObs && prevYearAgoObs) {
        prevYoy = (parseFloat(prevMonthObs.value) / parseFloat(prevYearAgoObs.value) - 1) * 100;
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

  // 6. Core CPI Year-over-Year
  if (coreCpiData.length >= 2) {
    const latestDate       = new Date(coreCpiData[0].date);
    const yearAgoTarget    = new Date(latestDate);
    yearAgoTarget.setFullYear(yearAgoTarget.getFullYear() - 1);
    const prevMonthTarget  = new Date(latestDate);
    prevMonthTarget.setMonth(prevMonthTarget.getMonth() - 1);
    const prevYearAgoTarget = new Date(prevMonthTarget);
    prevYearAgoTarget.setFullYear(prevYearAgoTarget.getFullYear() - 1);

    const yearAgoObs     = findClosestObservation(coreCpiData, yearAgoTarget);
    const prevMonthObs   = findClosestObservation(coreCpiData, prevMonthTarget);
    const prevYearAgoObs = findClosestObservation(coreCpiData, prevYearAgoTarget);

    if (yearAgoObs) {
      const latest  = parseFloat(coreCpiData[0].value);
      const yearAgo = parseFloat(yearAgoObs.value);
      const yoy     = (latest / yearAgo - 1) * 100;
      let prevYoy   = yoy;
      if (prevMonthObs && prevYearAgoObs) {
        prevYoy = (parseFloat(prevMonthObs.value) / parseFloat(prevYearAgoObs.value) - 1) * 100;
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

  // 8. Unemployment Rate
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

  // 9. Nonfarm Payrolls — monthly change
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

  return indicators;
}

/**
 * Find the FRED observation closest to a target date.
 * Tolerates up to 45 days of drift to handle missing months gracefully.
 */
export function findClosestObservation(
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
  const MAX_DRIFT_MS = 45 * 24 * 60 * 60 * 1000;
  return best && bestDiff <= MAX_DRIFT_MS ? best : null;
}
