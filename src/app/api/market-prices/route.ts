import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { MarketSnapshotItem, MarketPricesData } from "@/lib/news-types";
import { fetchFredSeries, fetchWtiCrudePrice } from "@/lib/market-data";

export const runtime = "nodejs";

const KV_KEY = "market-prices";
const CACHE_SECONDS = 60;

/**
 * GET /api/market-prices
 * Returns five Market Prices indicators for the homepage MacroBoard:
 *   S&P 500, VIX, WTI Oil, Dollar Index, Bitcoin
 *
 * Source priority (all parallel, per-indicator graceful-degrade):
 *   S&P 500    → FRED SP500 (daily close)
 *   VIX        → FRED VIXCLS (daily close) — change shown in POINTS, not %
 *   WTI Oil    → EIA (live) → FRED DCOILWTICO (daily fallback, with % change)
 *   Dollar Idx → TwelveData DXY → FMP DX-Y.NYB → FRED DTWEXBGS (broad USD index)
 *   Bitcoin    → TwelveData BTC/USD → FMP BTCUSD
 *
 * TTL: 60s server-side Redis cache
 * Returns sessionStatus + refreshIntervalMs for client smart polling.
 */
export async function GET() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  const session = getMarketSession();

  if (!url || !token) {
    const data = await buildPrices(session);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
    });
  }

  try {
    const kv = new Redis({ url, token });

    const cached = await kv.get<MarketPricesData>(KV_KEY);
    if (cached && new Date(cached.validUntil) > new Date()) {
      // Session metadata is time-dependent — always return fresh values
      return NextResponse.json(
        { ...cached, sessionStatus: session.status, refreshIntervalMs: session.refreshMs },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } }
      );
    }

    const data = await buildPrices(session);
    await kv.set(KV_KEY, data, { ex: CACHE_SECONDS });

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
    });
  } catch (err) {
    console.error("[/api/market-prices] Error:", err);
    const fallback = await buildPrices(session).catch(() => emptyPrices(session));
    return NextResponse.json(fallback, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Trading session detection (US Eastern Time, DST-aware)
// ---------------------------------------------------------------------------

function getMarketSession(): { status: "open" | "extended" | "closed"; refreshMs: number } {
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const day = etNow.getDay();
  const tm  = etNow.getHours() * 60 + etNow.getMinutes();

  if (day >= 1 && day <= 5) {
    if (tm >= 9 * 60 + 30 && tm < 16 * 60)  return { status: "open",     refreshMs: 60_000 };
    if (tm >= 16 * 60      && tm < 20 * 60)  return { status: "extended", refreshMs: 5 * 60_000 };
  }
  // Weekend / overnight — still refresh every 5min for BTC (trades 24/7)
  return { status: "closed", refreshMs: 5 * 60_000 };
}

// ---------------------------------------------------------------------------
// Main builder — all sources fetched in parallel, each degrades independently
// ---------------------------------------------------------------------------

async function buildPrices(
  session: { status: "open" | "extended" | "closed"; refreshMs: number }
): Promise<MarketPricesData> {
  const now      = new Date();
  const validUntil = new Date(now.getTime() + CACHE_SECONDS * 1000);

  // Fetch all FRED/EIA sources in parallel upfront so every indicator
  // has at least one reliable fallback regardless of TwelveData/FMP status.
  const [sp500Res, vixRes, wtiEiaRes, wtiCoRes, dxFredRes] = await Promise.allSettled([
    fetchFredSeries("SP500",      3),   // S&P 500 daily close
    fetchFredSeries("VIXCLS",     3),   // CBOE VIX daily close
    fetchWtiCrudePrice(),               // EIA WTI spot (primary, needs EIA_API_KEY)
    fetchFredSeries("DCOILWTICO", 3),   // FRED WTI spot fallback (1-day delay)
    fetchFredSeries("DTWEXBGS",   2),   // FRED Nominal Broad USD Index fallback for DXY
  ]);

  const itemMap = new Map<string, MarketSnapshotItem>();

  // ── S&P 500 ─────────────────────────────────────────────────────────────────
  const sp500Obs = sp500Res.status === "fulfilled" ? sp500Res.value : [];
  if (sp500Obs.length >= 1) {
    const latest = parseFloat(sp500Obs[0].value);
    const prev   = sp500Obs.length >= 2 ? parseFloat(sp500Obs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
      itemMap.set("S&P 500", {
        label:     "S&P 500",
        value:     Math.round(latest).toLocaleString(),
        change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        direction: pct > 0.01 ? "up" : pct < -0.01 ? "down" : "flat",
        source:    "Daily Close",
      });
    }
  }

  // ── VIX — change shown in POINTS, not percent (industry standard) ─────────
  // Formula: current − previous close  (e.g. "+3.06", not "+12.63%")
  const vixObs = vixRes.status === "fulfilled" ? vixRes.value : [];
  if (vixObs.length >= 1) {
    const latest = parseFloat(vixObs[0].value);
    const prev   = vixObs.length >= 2 ? parseFloat(vixObs[1].value) : NaN;
    if (!isNaN(latest)) {
      const pts = !isNaN(prev) ? latest - prev : 0;
      itemMap.set("VIX", {
        label:     "VIX",
        value:     latest.toFixed(2),
        change:    Math.abs(pts) < 0.005 ? "—" : `${pts >= 0 ? "+" : ""}${pts.toFixed(2)}`,
        direction: pts > 0.005 ? "up" : pts < -0.005 ? "down" : "flat",
        source:    "Daily Close",
      });
    }
  }

  // ── WTI Crude Oil ───────────────────────────────────────────────────────────
  // Primary: EIA live spot (no change available — only 1 data point returned)
  // Fallback: FRED DCOILWTICO (1-day delay, but includes previous close → % change)
  let wtiPlaced = false;

  if (wtiEiaRes.status === "fulfilled" && wtiEiaRes.value?.value != null) {
    itemMap.set("WTI Oil", {
      label:     "WTI Oil",
      value:     `$${wtiEiaRes.value.value.toFixed(2)}`,
      change:    "—",           // EIA returns single latest point — no prev close available
      direction: "flat",
      source:    "EIA",
    });
    wtiPlaced = true;
  }

  if (!wtiPlaced) {
    // FRED DCOILWTICO fallback — same underlying data as EIA, 1-day delay
    const wtiObs = wtiCoRes.status === "fulfilled" ? wtiCoRes.value : [];
    if (wtiObs.length >= 1) {
      const latest = parseFloat(wtiObs[0].value);
      const prev   = wtiObs.length >= 2 ? parseFloat(wtiObs[1].value) : NaN;
      if (!isNaN(latest)) {
        const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
        itemMap.set("WTI Oil", {
          label:     "WTI Oil",
          value:     `$${latest.toFixed(2)}`,
          change:    Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
          source:    "FRED",
        });
        wtiPlaced = true;
      }
    }
  }

  if (!wtiPlaced) {
    console.warn("[market-prices] WTI Oil unavailable — EIA_API_KEY missing or both EIA and FRED failed");
  }

  // ── TwelveData: DXY (Dollar Index) + BTC/USD (Bitcoin) ────────────────────
  // Fetched per-symbol so one failure never blocks the other.
  // FMP and FRED serve as progressive fallbacks for DXY only.
  const twKey  = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  if (twKey) {
    // Fetch DXY and BTC/USD separately — isolates failures per symbol
    const [dxyItem, btcItem] = await Promise.allSettled([
      fetchTwelveDataSingle(twKey, "DXY",     "Dollar Index", (p) => p.toFixed(2)),
      fetchTwelveDataSingle(twKey, "BTC/USD",  "Bitcoin",     (p) => `$${Math.round(p).toLocaleString()}`),
    ]);

    if (dxyItem.status === "fulfilled" && dxyItem.value) {
      itemMap.set("Dollar Index", dxyItem.value);
    } else {
      console.warn("[market-prices/TwelveData] DXY failed, trying FMP/FRED fallback");
    }

    if (btcItem.status === "fulfilled" && btcItem.value) {
      itemMap.set("Bitcoin", btcItem.value);
    } else {
      console.warn("[market-prices/TwelveData] BTC/USD failed, trying FMP fallback");
    }
  }

  // FMP fallback for any missing live symbols (DXY, BTC)
  if (fmpKey && (!itemMap.has("Dollar Index") || !itemMap.has("Bitcoin"))) {
    const fmpItems = await fetchFmpPrices(fmpKey, !itemMap.has("Dollar Index"), !itemMap.has("Bitcoin"));
    for (const item of fmpItems) itemMap.set(item.label, item);
  }

  // FRED DTWEXBGS fallback for Dollar Index if both TwelveData and FMP failed
  if (!itemMap.has("Dollar Index")) {
    const dxObs = dxFredRes.status === "fulfilled" ? dxFredRes.value : [];
    if (dxObs.length >= 1) {
      const latest = parseFloat(dxObs[0].value);
      const prev   = dxObs.length >= 2 ? parseFloat(dxObs[1].value) : NaN;
      if (!isNaN(latest)) {
        const pct = !isNaN(prev) && prev > 0 ? ((latest / prev - 1) * 100) : 0;
        itemMap.set("Dollar Index", {
          label:     "Dollar Index",
          value:     latest.toFixed(2),
          change:    Math.abs(pct) < 0.005 ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
          source:    "FRED",
        });
      }
    }
  }

  // ── Output in display order ───────────────────────────────────────────────
  const ORDER = ["S&P 500", "VIX", "WTI Oil", "Dollar Index", "Bitcoin"];
  const items = ORDER.map((k) => itemMap.get(k)).filter(Boolean) as MarketSnapshotItem[];

  return {
    items: items.slice(0, 5),
    sessionStatus:     session.status,
    refreshIntervalMs: session.refreshMs,
    generatedAt: now.toISOString(),
    validUntil:  validUntil.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TwelveData — fetch a single symbol with its own error handling
// Returns null if the symbol is unavailable or errors.
// ---------------------------------------------------------------------------

interface TwelveDataQuote {
  close?:          string;
  percent_change?: string;
  code?:           number;
  message?:        string;
}

async function fetchTwelveDataSingle(
  apiKey: string,
  symbol: string,
  label: string,
  formatValue: (price: number) => string,
): Promise<MarketSnapshotItem | null> {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 60 } }
    );
    if (!res.ok) {
      console.warn(`[market-prices/TwelveData] ${symbol}: HTTP ${res.status}`);
      return null;
    }

    // Single-symbol response is a flat object: { "close": "...", "percent_change": "..." }
    // Error response:                           { "code": 400, "message": "..." }
    const raw = (await res.json()) as TwelveDataQuote;

    if (raw.code) {
      console.warn(`[market-prices/TwelveData] ${symbol}: ${raw.message}`);
      return null;
    }
    if (!raw.close) {
      console.warn(`[market-prices/TwelveData] ${symbol}: no close price in response`);
      return null;
    }

    const price = parseFloat(raw.close);
    if (isNaN(price)) return null;

    const pct = parseFloat(raw.percent_change ?? "0");

    return {
      label,
      value:     formatValue(price),
      change:    `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      direction: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat",
      source:    "TwelveData",
    };
  } catch (err) {
    console.error(`[market-prices/TwelveData] ${symbol} fetch error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FMP (Financial Modeling Prep) — fallback for DXY + BTC
// ---------------------------------------------------------------------------

interface FmpQuote {
  symbol:            string;
  price:             number;
  changesPercentage: number;
}

async function fetchFmpPrices(
  apiKey: string,
  needDxy: boolean,
  needBtc: boolean,
): Promise<MarketSnapshotItem[]> {
  const symbols: string[] = [];
  if (needDxy) symbols.push("DX-Y.NYB");
  if (needBtc) symbols.push("BTCUSD");
  if (symbols.length === 0) return [];

  try {
    const res = await fetch(
      `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 60 } }
    );
    if (!res.ok) return [];

    const quotes = (await res.json()) as FmpQuote[];

    return quotes.flatMap((q) => {
      const pct    = q.changesPercentage ?? 0;
      const pctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      const dir    = (pct > 0 ? "up" : pct < 0 ? "down" : "flat") as "up" | "down" | "flat";

      if (q.symbol === "DX-Y.NYB") {
        return [{
          label:     "Dollar Index",
          value:     q.price.toFixed(2),
          change:    pctStr,
          direction: dir,
          source:    "FMP",
        }];
      }
      if (q.symbol === "BTCUSD") {
        return [{
          label:     "Bitcoin",
          value:     `$${Math.round(q.price).toLocaleString()}`,
          change:    pctStr,
          direction: dir,
          source:    "FMP",
        }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Empty fallback
// ---------------------------------------------------------------------------

function emptyPrices(session: { status: string; refreshMs: number }): MarketPricesData {
  return {
    items:             [],
    sessionStatus:     session.status as "open" | "extended" | "closed",
    refreshIntervalMs: session.refreshMs,
    generatedAt:       new Date().toISOString(),
    validUntil:        new Date(Date.now() + 60_000).toISOString(),
  };
}
