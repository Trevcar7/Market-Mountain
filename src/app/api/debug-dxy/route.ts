import { NextResponse } from "next/server";
import { fetchFredSeries } from "@/lib/market-data";

export const runtime = "nodejs";

/**
 * GET /api/debug-dxy
 * Diagnostic endpoint — tests all three DXY data sources in parallel and
 * returns the raw results so you can see exactly what's working.
 *
 * Remove this file once the correct DXY source is confirmed.
 */
export async function GET() {
  const twKey   = process.env.TWELVEDATA_API_KEY;
  const polyKey = process.env.POLYGON_API_KEY;
  const fmpKey  = process.env.FMP_API_KEY;

  const results: Record<string, unknown> = {
    env: {
      TWELVEDATA_API_KEY:  twKey   ? `set (${twKey.slice(0, 4)}…)`   : "NOT SET",
      POLYGON_API_KEY:     polyKey ? `set (${polyKey.slice(0, 4)}…)`  : "NOT SET",
      FMP_API_KEY:         fmpKey  ? `set (${fmpKey.slice(0, 4)}…)`   : "NOT SET",
    },
  };

  // ── TwelveData DXY (expected: FAIL — symbol not in their catalog) ──────────
  if (twKey) {
    try {
      const res = await fetch(
        `https://api.twelvedata.com/quote?symbol=DXY&apikey=${twKey}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const raw = await res.json();
      results.twelvedata_dxy = { http: res.status, body: raw };
    } catch (err) {
      results.twelvedata_dxy = { error: String(err) };
    }
  } else {
    results.twelvedata_dxy = "SKIPPED — no TWELVEDATA_API_KEY";
  }

  // ── Polygon C:DXY (expected: OK if key is set and C:DXY is supported) ──────
  if (polyKey) {
    try {
      const res = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/global/markets/forex/tickers/C:DXY?apiKey=${polyKey}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const raw = await res.json();
      results.polygon_cdxy = { http: res.status, body: raw };
    } catch (err) {
      results.polygon_cdxy = { error: String(err) };
    }
  } else {
    results.polygon_cdxy = "SKIPPED — no POLYGON_API_KEY";
  }

  // ── FMP DX-Y.NYB (expected: OK if key + plan supports futures) ─────────────
  if (fmpKey) {
    try {
      const res = await fetch(
        `https://financialmodelingprep.com/api/v3/quote/DX-Y.NYB?apikey=${fmpKey}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const raw = await res.json();
      results.fmp_dxy = { http: res.status, body: raw };
    } catch (err) {
      results.fmp_dxy = { error: String(err) };
    }
  } else {
    results.fmp_dxy = "SKIPPED — no FMP_API_KEY";
  }

  // ── FRED DTWEXBGS (last resort — different index, weekly updates) ──────────
  try {
    const obs = await fetchFredSeries("DTWEXBGS", 2);
    results.fred_dtwexbgs = obs.length > 0
      ? { latest: obs[0], prev: obs[1] ?? null }
      : { error: "no observations returned" };
  } catch (err) {
    results.fred_dtwexbgs = { error: String(err) };
  }

  return NextResponse.json(results, {
    headers: { "Cache-Control": "no-store" },
  });
}
