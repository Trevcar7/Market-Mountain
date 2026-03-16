import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { MarketSnapshotItem, MarketPricesData } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-prices";
const CACHE_SECONDS = 5 * 60; // 5 minutes

/**
 * GET /api/market-prices
 * Returns five Market Prices indicators for the homepage MacroBoard:
 *   S&P 500, VIX, WTI Oil, Dollar Index, Bitcoin
 *
 * Same hybrid approach as market-snapshot: FRED baselines + TwelveData ETF % change.
 */
export async function GET() {
  const kv = getRedisClient();
  const session = getMarketSession();

  if (!kv) {
    const data = await buildPrices(session);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  }

  try {
    const cached = await kv.get<MarketPricesData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      return NextResponse.json(
        { ...cached, sessionStatus: session.status, refreshIntervalMs: session.refreshMs },
        { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } }
      );
    }

    const data = await buildPrices(session);
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[/api/market-prices] Error:", err);
    const fallback = await buildPrices(session).catch(() => emptyPrices(session));
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Trading session detection
// ---------------------------------------------------------------------------

function getMarketSession(): { status: "open" | "extended" | "closed"; refreshMs: number } {
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const day = etNow.getDay();
  const tm  = etNow.getHours() * 60 + etNow.getMinutes();

  if (day >= 1 && day <= 5) {
    if (tm >= 9 * 60 + 30 && tm < 16 * 60)  return { status: "open",     refreshMs: 5 * 60_000 };
    if (tm >= 16 * 60      && tm < 20 * 60)  return { status: "extended", refreshMs: 5 * 60_000 };
  }
  return { status: "closed", refreshMs: 5 * 60_000 };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

async function buildPrices(
  session: { status: "open" | "extended" | "closed"; refreshMs: number }
): Promise<MarketPricesData> {
  const now      = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);
  const twKey    = process.env.TWELVEDATA_API_KEY;

  // ── Phase 1: FRED baselines ──────────────────────────────────────────────
  const [sp500Res, vixRes, wtiEiaRes, wtiCoRes, dxFredRes] = await Promise.allSettled([
    fetchFredSeries("SP500",      3),
    fetchFredSeries("VIXCLS",     3),
    fetchWtiCrudePrice(),
    fetchFredSeries("DCOILWTICO", 3),
    fetchFredSeries("DTWEXBGS",   2),
  ]);

  const itemMap = new Map<string, MarketSnapshotItem>();

  // S&P 500
  const sp500Obs = sp500Res.status === "fulfilled" ? sp500Res.value : [];
  if (sp500Obs.length >= 1) {
    const latest = parseFloat(sp500Obs[0].value);
    const prev   = sp500Obs.length >= 2 ? parseFloat(sp500Obs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("S&P 500", {
        label: "S&P 500", value: Math.round(latest).toLocaleString(),
        change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.01 ? "up" : pct < -0.01 ? "down" : "flat",
        source: "FRED",
      });
    }
  }

  // VIX (points)
  const vixObs = vixRes.status === "fulfilled" ? vixRes.value : [];
  if (vixObs.length >= 1) {
    const latest = parseFloat(vixObs[0].value);
    const prev   = vixObs.length >= 2 ? parseFloat(vixObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pts = !isNaN(prev) ? latest - prev : 0;
      itemMap.set("VIX", {
        label: "VIX", value: latest.toFixed(2),
        change: Math.abs(pts) < 0.005 ? "—" : `${pts >= 0 ? "+" : ""}${pts.toFixed(2)}`,
        direction: pts > 0.005 ? "up" : pts < -0.005 ? "down" : "flat",
        source: "FRED",
      });
    }
  }

  // WTI Oil
  if (wtiEiaRes.status === "fulfilled" && wtiEiaRes.value?.value != null) {
    itemMap.set("WTI Oil", {
      label: "WTI Oil", value: `$${wtiEiaRes.value.value.toFixed(2)}`,
      change: "—", direction: "flat", source: "EIA",
    });
  } else {
    const wtiObs = wtiCoRes.status === "fulfilled" ? wtiCoRes.value : [];
    if (wtiObs.length >= 1) {
      const latest = parseFloat(wtiObs[0].value);
      const prev   = wtiObs.length >= 2 ? parseFloat(wtiObs[1].value) : NaN;
      if (!isNaN(latest)) {
        const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
        itemMap.set("WTI Oil", {
          label: "WTI Oil", value: `$${latest.toFixed(2)}`,
          change: Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
          source: "FRED",
        });
      }
    }
  }

  // Dollar Index
  const dxObs = dxFredRes.status === "fulfilled" ? dxFredRes.value : [];
  if (dxObs.length >= 1) {
    const latest = parseFloat(dxObs[0].value);
    const prev   = dxObs.length >= 2 ? parseFloat(dxObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("Dollar Index", {
        label: "Dollar Index", value: latest.toFixed(2),
        change: Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
        source: "FRED",
      });
    }
  }

  // ── Phase 2: TwelveData ETF hybrid override ────────────────────────────
  if (twKey) {
    const [spyRes, btcRes, usoRes] = await Promise.allSettled([
      fetchTDQuote(twKey, "SPY"),
      fetchTDQuote(twKey, "BTC/USD"),
      fetchTDQuote(twKey, "USO"),
    ]);

    // S&P 500 via SPY
    if (spyRes.status === "fulfilled" && spyRes.value) {
      const spy = spyRes.value;
      const fredBase = parseVal(itemMap.get("S&P 500")?.value);
      if (!isNaN(fredBase) && fredBase > 0) {
        const approx = Math.round(fredBase * (1 + spy.pct / 100));
        itemMap.set("S&P 500", {
          label: "S&P 500", value: approx.toLocaleString(),
          change: `${spy.pct >= 0 ? "+" : ""}${spy.pct.toFixed(2)}%`,
          direction: spy.pct > 0.01 ? "up" : spy.pct < -0.01 ? "down" : "flat",
          source: "TwelveData",
        });
      }
    }

    // Bitcoin direct
    if (btcRes.status === "fulfilled" && btcRes.value) {
      const btc = btcRes.value;
      itemMap.set("Bitcoin", {
        label: "Bitcoin", value: `$${Math.round(btc.price).toLocaleString()}`,
        change: `${btc.pct >= 0 ? "+" : ""}${btc.pct.toFixed(2)}%`,
        direction: btc.pct > 0.005 ? "up" : btc.pct < -0.005 ? "down" : "flat",
        source: "TwelveData",
      });
    }

    // WTI Oil via USO
    if (usoRes.status === "fulfilled" && usoRes.value) {
      const uso = usoRes.value;
      const fredBase = parseVal(itemMap.get("WTI Oil")?.value);
      if (!isNaN(fredBase) && fredBase > 0) {
        const approx = fredBase * (1 + uso.pct / 100);
        itemMap.set("WTI Oil", {
          label: "WTI Oil", value: `$${approx.toFixed(2)}`,
          change: `${uso.pct >= 0 ? "+" : ""}${uso.pct.toFixed(2)}%`,
          direction: uso.pct > 0.005 ? "up" : uso.pct < -0.005 ? "down" : "flat",
          source: "TwelveData",
        });
      }
    }

    // Brief pause then fetch UUP for Dollar Index
    await new Promise((r) => setTimeout(r, 1500));
    const [uupRes] = await Promise.allSettled([fetchTDQuote(twKey, "UUP")]);

    if (uupRes.status === "fulfilled" && uupRes.value) {
      const uup = uupRes.value;
      const fredBase = parseVal(itemMap.get("Dollar Index")?.value);
      if (!isNaN(fredBase) && fredBase > 0) {
        const approx = fredBase * (1 + uup.pct / 100);
        itemMap.set("Dollar Index", {
          label: "Dollar Index", value: approx.toFixed(2),
          change: `${uup.pct >= 0 ? "+" : ""}${uup.pct.toFixed(2)}%`,
          direction: uup.pct > 0.005 ? "up" : uup.pct < -0.005 ? "down" : "flat",
          source: "TwelveData",
        });
      }
    }
  }

  const ORDER = ["S&P 500", "VIX", "WTI Oil", "Dollar Index", "Bitcoin"];
  const items = ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  return {
    items: items.slice(0, 5),
    sessionStatus: session.status,
    refreshIntervalMs: session.refreshMs,
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData quote helper
// ---------------------------------------------------------------------------

interface TDRaw { price: number; pct: number; }

async function fetchTDQuote(apiKey: string, symbol: string): Promise<TDRaw | null> {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), cache: "no-store" }
    );
    if (!res.ok) return null;
    const raw = await res.json();
    if (raw.code || !raw.close) return null;
    const price = parseFloat(raw.close);
    if (isNaN(price)) return null;
    let pct = raw.percent_change != null ? parseFloat(raw.percent_change) : NaN;
    if (isNaN(pct) || Math.abs(pct) < 0.005) {
      const chg  = raw.change         != null ? parseFloat(raw.change)         : NaN;
      const prev = raw.previous_close != null ? parseFloat(raw.previous_close) : NaN;
      if (!isNaN(chg) && !isNaN(prev) && prev > 0) pct = (chg / prev) * 100;
    }
    return { price, pct: isNaN(pct) ? 0 : pct };
  } catch { return null; }
}

function parseVal(s: string | undefined): number {
  return s ? parseFloat(s.replace(/[$,]/g, "")) : NaN;
}

function emptyPrices(session: { status: string; refreshMs: number }): MarketPricesData {
  return {
    items: [], sessionStatus: session.status as "open" | "extended" | "closed",
    refreshIntervalMs: session.refreshMs,
    generatedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}
