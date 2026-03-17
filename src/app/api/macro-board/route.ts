import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { MacroBoardData, MacroIndicator, RegimeDimensions } from "@/lib/news-types";
import { buildMacroBoardIndicators } from "@/lib/macro-board-builder";

export const runtime = "nodejs";

const KV_KEY = "macro-board";
const CACHE_SECONDS = 300; // 5-minute Redis TTL — matches client poll interval

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

    // Only cache if we got a meaningful dataset (≥5 indicators).
    // If FRED/EIA are down we might only get BLS data — don't cache that
    // partial result so the next request retries fresh.
    const MIN_INDICATORS_TO_CACHE = 5;
    if (data.indicators.length >= MIN_INDICATORS_TO_CACHE) {
      await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });
    } else {
      console.warn(`[/api/macro-board] Only ${data.indicators.length} indicators resolved — skipping cache`);
    }

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

  const indicators: MacroIndicator[] = await buildMacroBoardIndicators();

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
