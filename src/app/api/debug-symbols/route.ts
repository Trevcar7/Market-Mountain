import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TEST_SYMBOLS = [
  "SPX", "SPY", "GSPC",
  "VIX", "UVXY",
  "WTI/USD", "USO", "CL",
  "DXY", "UUP", "DX",
  "XAU/USD", "BTC/USD",
];

export async function GET() {
  const twKey = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  if (!twKey) {
    return NextResponse.json({ error: "TWELVEDATA_API_KEY not set" });
  }

  const results: Record<string, unknown> = {};

  // Test each symbol against TwelveData /quote
  for (const symbol of TEST_SYMBOLS) {
    try {
      const res = await fetch(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${twKey}`,
        { signal: AbortSignal.timeout(5000), cache: "no-store" }
      );
      const data = await res.json();
      if (data.code) {
        results[symbol] = { status: "error", code: data.code, message: data.message };
      } else if (data.close) {
        results[symbol] = {
          status: "ok",
          close: data.close,
          percent_change: data.percent_change,
          change: data.change,
          previous_close: data.previous_close,
          name: data.name,
        };
      } else {
        results[symbol] = { status: "unknown", data };
      }
    } catch (err) {
      results[symbol] = { status: "fetch_error", error: String(err) };
    }
  }

  // Test FMP
  const fmpResult: Record<string, unknown> = {};
  if (fmpKey) {
    try {
      const res = await fetch(
        `https://financialmodelingprep.com/api/v3/quote/%5EGSPC,%5EVIX,BTCUSD,DX-Y.NYB,CLUSD,XAUUSD?apikey=${fmpKey}`,
        { signal: AbortSignal.timeout(5000), cache: "no-store" }
      );
      const data = await res.json();
      fmpResult.status = res.ok ? "ok" : `HTTP ${res.status}`;
      fmpResult.data = data;
    } catch (err) {
      fmpResult.status = "error";
      fmpResult.error = String(err);
    }
  } else {
    fmpResult.status = "FMP_API_KEY not set";
  }

  return NextResponse.json({ twelvedata: results, fmp: fmpResult });
}
