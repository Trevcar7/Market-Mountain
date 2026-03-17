/**
 * Shared macro board indicator builder.
 * Used by both /api/macro-board and /api/briefing-macro so the briefing
 * page's Macro Snapshot always shows the exact same data as the homepage
 * MacroBoard.
 */

import {
  fetchFredSeries,
  fetchWtiCrudePrice,
  BLS_SERIES,
  fetchBlsMultipleSeries,
} from "@/lib/market-data";
import type { MacroIndicator } from "@/lib/news-types";

/**
 * Fetch and compute all macro indicators.
 * Each source gracefully degrades to an empty result on failure.
 */
export async function buildMacroBoardIndicators(): Promise<MacroIndicator[]> {
  const [fedObs, tenYearObs, twoYearObs, cpiObs, coreCpiObs, wtiObs, blsObs] =
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
    ]);

  const fedData     = fedObs.status     === "fulfilled" ? fedObs.value     : [];
  const tenYearData = tenYearObs.status === "fulfilled" ? tenYearObs.value : [];
  const twoYearData = twoYearObs.status === "fulfilled" ? twoYearObs.value : [];
  const cpiData     = cpiObs.status     === "fulfilled" ? cpiObs.value     : [];
  const coreCpiData = coreCpiObs.status === "fulfilled" ? coreCpiObs.value : [];
  const wtiData     = wtiObs.status     === "fulfilled" ? wtiObs.value     : null;
  const blsRaw      = blsObs.status     === "fulfilled" ? blsObs.value     : {};

  const payrollsArr = blsRaw[BLS_SERIES.NONFARM_PAYROLLS] ?? [];
  const unemployArr = blsRaw[BLS_SERIES.UNEMPLOYMENT]     ?? [];

  const indicators: MacroIndicator[] = [];

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
  if (tenYearData.length > 0) {
    const current  = parseFloat(tenYearData[0].value);
    const previous = tenYearData.length > 1 ? parseFloat(tenYearData[1].value) : current;
    const changeBps = Math.round((current - previous) * 100);
    indicators.push({
      label: "10-Year Yield",
      value: `${current.toFixed(2)}%`,
      change: changeBps !== 0
        ? `${changeBps > 0 ? "+" : ""}${changeBps}bps`
        : undefined,
      direction: current > previous ? "up" : current < previous ? "down" : "flat",
      source: "FRED",
      updatedAt: tenYearData[0].date,
    });
  }

  // 3. 2-Year Treasury Yield
  if (twoYearData.length > 0) {
    const current  = parseFloat(twoYearData[0].value);
    const previous = twoYearData.length > 1 ? parseFloat(twoYearData[1].value) : current;
    const changeBps = Math.round((current - previous) * 100);
    indicators.push({
      label: "2-Year Yield",
      value: `${current.toFixed(2)}%`,
      change: changeBps !== 0
        ? `${changeBps > 0 ? "+" : ""}${changeBps}bps`
        : undefined,
      direction: current > previous ? "up" : current < previous ? "down" : "flat",
      source: "FRED",
      updatedAt: twoYearData[0].date,
    });
  }

  // 4. Yield Curve (10Y – 2Y spread)
  if (tenYearData.length > 0 && twoYearData.length > 0) {
    const ten      = parseFloat(tenYearData[0].value);
    const two      = parseFloat(twoYearData[0].value);
    const spread   = ten - two;
    const prevTen  = tenYearData.length > 1 ? parseFloat(tenYearData[1].value) : ten;
    const prevTwo  = twoYearData.length > 1 ? parseFloat(twoYearData[1].value) : two;
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
      source: "FRED",
      updatedAt: tenYearData[0].date,
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
