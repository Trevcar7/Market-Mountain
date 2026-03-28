/**
 * External market data API wrappers — server-side only.
 *
 * All functions degrade gracefully: they return null or [] when the
 * corresponding API key is absent or the request fails. Never throws.
 * Keys are read exclusively from process.env — never exposed to the client.
 *
 * Required environment variables (all optional at build time):
 *   FRED_API_KEY           — St. Louis Fed (api.stlouisfed.org)
 *   BLS_API_KEY            — Bureau of Labor Statistics (api.bls.gov)
 *   EIA_API_KEY            — U.S. Energy Information Administration (api.eia.gov)
 *   ALPHAVANTAGE_API_KEY   — Alpha Vantage (alphavantage.co)
 *   FMP_API_KEY            — Financial Modeling Prep (financialmodelingprep.com)
 *   POLYGON_API_KEY        — Polygon.io (optional, advanced tick data)
 *
 * Integration map:
 *   EIA  → energy/commodity evidence, WTI/Brent/gas charts, trade_policy context
 *   FMP  → earnings evidence, company fundamentals, briefing "What to Watch"
 *   BLS  → labor/inflation evidence, CPI/unemployment charts, multi-series POST
 *   FRED → macro/bond/GDP evidence, rate charts (unchanged)
 *   AV   → market index quotes (broad_market/markets topics)
 */

import { KeyDataPoint, ChartDataset } from "./news-types";

// ---------------------------------------------------------------------------
// Shared timeout helper
// ---------------------------------------------------------------------------

function withTimeout(ms = 8000): AbortSignal {
  return AbortSignal.timeout(ms);
}

function logWarn(api: string, msg: string): void {
  console.warn(`[market-data:${api}] ${msg}`);
}

// ---------------------------------------------------------------------------
// SECTION 1 — FRED (Federal Reserve Economic Data)
// ---------------------------------------------------------------------------

interface FredObservation {
  date: string;
  value: string;
}

interface FredApiResponse {
  observations?: FredObservation[];
}

/**
 * Fetch the N most recent observations for a FRED series (descending).
 * Requires FRED_API_KEY. Returns [] on failure or missing key.
 */
export async function fetchFredSeries(
  seriesId: string,
  limit = 12
): Promise<FredObservation[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return [];

  try {
    const url =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${encodeURIComponent(seriesId)}` +
      `&api_key=${apiKey}` +
      `&file_type=json` +
      `&limit=${limit}` +
      `&sort_order=desc`;

    const res = await fetch(url, { signal: withTimeout() });
    if (!res.ok) {
      logWarn("FRED", `HTTP ${res.status} for series ${seriesId}`);
      return [];
    }

    const data: FredApiResponse = await res.json();
    return (data.observations ?? []).filter((o) => o.value !== ".");
  } catch (err) {
    logWarn("FRED", `fetch failed for ${seriesId}: ${String(err)}`);
    return [];
  }
}

/** Fetch the single most-recent FRED observation. */
export async function fetchFredLatest(
  seriesId: string
): Promise<FredObservation | null> {
  const obs = await fetchFredSeries(seriesId, 1);
  return obs[0] ?? null;
}

/** Fetch latest + previous FRED observation to compute a change value. */
export async function fetchFredWithChange(
  seriesId: string
): Promise<{ value: string; change: string } | null> {
  const obs = await fetchFredSeries(seriesId, 2);
  if (!obs[0]) return null;
  const latest = parseFloat(obs[0].value);
  const prev = obs[1] ? parseFloat(obs[1].value) : null;
  if (isNaN(latest)) return null;
  const changeStr = prev !== null && !isNaN(prev)
    ? `${latest >= prev ? "+" : ""}${(latest - prev).toFixed(2)}`
    : undefined;
  return { value: obs[0].value, change: changeStr ?? "" };
}

// ---------------------------------------------------------------------------
// Yahoo Finance Treasury Yield (same-day, no key required)
// ---------------------------------------------------------------------------

/** Yahoo Finance symbol map for treasury yields */
const YIELD_YAHOO_SYMBOLS: Record<string, string> = {
  DGS10: "^TNX",
  DGS30: "^TYX",
};

/**
 * Fetch a treasury yield from Yahoo Finance's v8 chart endpoint.
 * Returns value + change in the same format as fetchFredWithChange.
 * Falls back gracefully — returns null if Yahoo is unavailable.
 */
export async function fetchYahooYield(
  symbol: string
): Promise<{ value: string; change: string } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      {
        signal: withTimeout(6000),
        cache: "no-store",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MarketMountain/1.0)",
          "Accept": "application/json",
        },
      }
    );
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const current = result.meta?.regularMarketPrice;
    if (!current || current <= 0) return null;

    // Compute previous close from chart close array
    let previous = current;
    const closes = result.indicators?.quote?.[0]?.close;
    if (Array.isArray(closes) && closes.length >= 2) {
      const valid = closes.filter((c: unknown): c is number => typeof c === "number" && c > 0);
      if (valid.length >= 2) previous = valid[valid.length - 2];
    }

    const change = current - previous;
    const changeStr = Math.abs(change) > 0.001
      ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}`
      : "";

    return { value: current.toFixed(2), change: changeStr };
  } catch {
    return null;
  }
}

/**
 * Fetch a treasury yield with Yahoo Finance → FRED fallback.
 * Provides same-day accuracy when Yahoo is available, with FRED as backup.
 * Only works for FRED series that have a Yahoo equivalent (DGS10, DGS30).
 */
export async function fetchTreasuryYieldWithChange(
  fredSeriesId: string
): Promise<{ value: string; change: string; source: string } | null> {
  const yahooSymbol = YIELD_YAHOO_SYMBOLS[fredSeriesId];

  if (yahooSymbol) {
    const yahoo = await fetchYahooYield(yahooSymbol);
    if (yahoo) return { ...yahoo, source: "Yahoo" };
  }

  const fred = await fetchFredWithChange(fredSeriesId);
  if (fred) return { ...fred, source: "FRED" };

  return null;
}

/**
 * Build a chart-ready dataset from a FRED series.
 * Returns chronologically ordered { labels, values } or null.
 */
export async function fetchFredChartSeries(
  seriesId: string,
  limit = 12
): Promise<{ labels: string[]; values: number[] } | null> {
  const obs = await fetchFredSeries(seriesId, limit);
  if (obs.length === 0) return null;

  // FRED returns desc — reverse for chronological order
  const chrono = [...obs].reverse();

  return {
    labels: chrono.map((o) => o.date),
    values: chrono.map((o) => parseFloat(o.value)),
  };
}

// ---------------------------------------------------------------------------
// SECTION 2 — BLS (Bureau of Labor Statistics)
// ---------------------------------------------------------------------------
//
// BLS v2 API uses a POST request with JSON body.
// The registrationkey is passed INSIDE the request body (not a query param).
// Without a key the API still works but is limited to 25 req/day and 10 years.
// Multi-series: send an array of seriesids in one POST call (up to 25).
//
// Key series IDs used:
//   CUUR0000SA0   — CPI-U All Items (not seasonally adjusted)
//   CUUR0000SA0L1E— Core CPI (CPI-U All Items Less Food & Energy)
//   LNS14000000   — Unemployment Rate (seasonally adjusted)
//   CES0000000001 — Total Nonfarm Payrolls (in thousands)
//   CES0500000003 — Avg Hourly Earnings, Private Sector
//   PCU---------  — PPI (use WPUFD4 for finished goods)
// ---------------------------------------------------------------------------

export const BLS_SERIES = {
  CPI_ALL:           "CUUR0000SA0",
  CPI_CORE:          "CUUR0000SA0L1E",
  UNEMPLOYMENT:      "LNS14000000",
  NONFARM_PAYROLLS:  "CES0000000001",
  AVG_HOURLY_WAGES:  "CES0500000003",
  PPI_FINISHED:      "WPUFD4",
} as const;

interface BlsDataPoint {
  year: string;
  period: string;       // e.g. "M03" for March
  periodName: string;   // e.g. "March"
  value: string;
}

interface BlsSeriesResult {
  seriesID: string;
  data?: BlsDataPoint[];
}

interface BlsApiResponse {
  status?: string;
  Results?: { series?: BlsSeriesResult[] };
  message?: string[];
}

/**
 * Fetch multiple BLS series in a single POST call.
 * The registrationkey is passed in the request body per BLS v2 spec.
 * Falls back to anonymous (no key) if BLS_API_KEY is absent — still works
 * but subject to anonymous rate limits (25 req/day).
 *
 * Returns a map of seriesID → data points, or {} on failure.
 */
export async function fetchBlsMultipleSeries(
  seriesIds: string[],
  yearsBack = 1
): Promise<Record<string, BlsDataPoint[]>> {
  const apiKey = process.env.BLS_API_KEY; // Optional — works without key too

  const currentYear = new Date().getFullYear();
  const startYear = String(currentYear - yearsBack);
  const endYear = String(currentYear);

  const body: Record<string, unknown> = {
    seriesid: seriesIds,
    startyear: startYear,
    endyear: endYear,
  };

  // Pass key in body per BLS v2 spec — enables higher limits
  if (apiKey) {
    body.registrationkey = apiKey;
  }

  try {
    const res = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: withTimeout(10000),
    });

    if (!res.ok) {
      logWarn("BLS", `HTTP ${res.status} for series [${seriesIds.join(", ")}]`);
      return {};
    }

    const data: BlsApiResponse = await res.json();

    if (data.status !== "REQUEST_SUCCEEDED") {
      const msgs = data.message?.join("; ") ?? "unknown error";
      logWarn("BLS", `Request did not succeed: ${msgs}`);
      return {};
    }

    const result: Record<string, BlsDataPoint[]> = {};
    for (const series of data.Results?.series ?? []) {
      result[series.seriesID] = series.data ?? [];
    }
    return result;
  } catch (err) {
    logWarn("BLS", `fetch failed: ${String(err)}`);
    return {};
  }
}

/**
 * Fetch a single BLS series and return the latest data point.
 * Uses the multi-series function for consistent auth handling.
 */
export async function fetchBlsLatest(
  seriesId: string
): Promise<{ value: string; period: string } | null> {
  const result = await fetchBlsMultipleSeries([seriesId], 1);
  const points = result[seriesId];
  if (!points || points.length === 0) return null;

  const latest = points[0]; // BLS returns most recent first
  return {
    value: latest.value,
    period: `${latest.periodName} ${latest.year}`,
  };
}

/**
 * Fetch a BLS series as a chart-ready dataset (chronological).
 * Returns { labels, values } or null if unavailable.
 */
export async function fetchBlsChartSeries(
  seriesId: string,
  yearsBack = 2
): Promise<{ labels: string[]; values: number[] } | null> {
  const result = await fetchBlsMultipleSeries([seriesId], yearsBack);
  const points = result[seriesId];
  if (!points || points.length < 3) return null;

  // BLS returns most-recent first — reverse for chronological order
  const chrono = [...points].reverse();

  return {
    labels: chrono.map((p) => `${p.periodName.substring(0, 3)} ${p.year}`),
    values: chrono.map((p) => parseFloat(p.value)),
  };
}

/**
 * Convenience: fetch CPI, Unemployment, and Payrolls in one network call.
 * Returns whatever succeeded — never throws.
 */
export async function fetchBlsMacroSummary(): Promise<{
  cpi: BlsDataPoint | null;
  unemployment: BlsDataPoint | null;
  payrolls: BlsDataPoint | null;
  wages: BlsDataPoint | null;
}> {
  const seriesIds = [
    BLS_SERIES.CPI_ALL,
    BLS_SERIES.UNEMPLOYMENT,
    BLS_SERIES.NONFARM_PAYROLLS,
    BLS_SERIES.AVG_HOURLY_WAGES,
  ];

  const result = await fetchBlsMultipleSeries(seriesIds, 1);

  return {
    cpi:          result[BLS_SERIES.CPI_ALL]?.[0]          ?? null,
    unemployment: result[BLS_SERIES.UNEMPLOYMENT]?.[0]     ?? null,
    payrolls:     result[BLS_SERIES.NONFARM_PAYROLLS]?.[0] ?? null,
    wages:        result[BLS_SERIES.AVG_HOURLY_WAGES]?.[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// SECTION 3 — EIA (U.S. Energy Information Administration)
// ---------------------------------------------------------------------------
//
// EIA v2 REST API: GET https://api.eia.gov/v2/{route}/data/
// api_key is a query parameter. Supports facets for series filtering.
//
// Key series used:
//   Petroleum spot prices (daily):
//     RWTC  — WTI Crude (Cushing, OK)
//     RBRTE — Brent Crude (Europe)
//   Natural gas (monthly):
//     NUS   — Henry Hub / U.S. citygate average
//   Gasoline retail (weekly):
//     EMM_EPM0_PTE_NUS_DPG — U.S. regular gasoline retail price
//   Crude inventories (weekly):
//     WCESTUS1 — U.S. commercial crude oil stocks (thousands barrels)
// ---------------------------------------------------------------------------

interface EiaDataPoint {
  period: string;
  value: number | null;
  "series-description"?: string;
}

interface EiaApiResponse {
  response?: {
    data?: EiaDataPoint[];
    total?: number;
  };
  error?: string;
}

/**
 * Generic EIA v2 data fetcher.
 * route: e.g. "petroleum/pri/spt"
 * facets: e.g. { series: ["RWTC"] }
 * frequency: "daily" | "weekly" | "monthly" | "annual"
 */
async function fetchEiaData(
  route: string,
  facets: Record<string, string[]>,
  frequency: "daily" | "weekly" | "monthly" | "annual",
  length = 1
): Promise<EiaDataPoint[]> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) return [];

  try {
    // EIA v2 requires literal bracket notation in query params (data[0]=, facets[series][]=, etc.).
    // URLSearchParams percent-encodes brackets (%5B%5D), which EIA rejects with HTTP 400.
    // Build the query string manually to preserve literal brackets.
    const base = new URLSearchParams({
      api_key: apiKey,
      frequency,
      length: String(length),
    });
    let qs = base.toString();
    qs += "&data[0]=value";
    qs += "&sort[0][column]=period&sort[0][order]=desc";
    for (const [facet, values] of Object.entries(facets)) {
      for (const v of values) {
        qs += `&facets[${facet}][]=${encodeURIComponent(v)}`;
      }
    }

    const url = `https://api.eia.gov/v2/${route}/data/?${qs}`;
    const res = await fetch(url, { signal: withTimeout() });

    if (!res.ok) {
      logWarn("EIA", `HTTP ${res.status} for route ${route}`);
      return [];
    }

    const data: EiaApiResponse = await res.json();
    if (data.error) {
      logWarn("EIA", `API error for ${route}: ${data.error}`);
      return [];
    }

    return (data.response?.data ?? []).filter((d) => d.value !== null);
  } catch (err) {
    logWarn("EIA", `fetch failed for ${route}: ${String(err)}`);
    return [];
  }
}

/** WTI crude oil spot price — latest ($/bbl). */
export async function fetchWtiCrudePrice(): Promise<{ value: number; period: string } | null> {
  const data = await fetchEiaData("petroleum/pri/spt", { series: ["RWTC"] }, "daily", 1);
  const latest = data[0];
  if (!latest || latest.value === null) return null;
  return { value: latest.value, period: latest.period };
}

/** Brent crude oil spot price — latest ($/bbl). */
export async function fetchBrentCrudePrice(): Promise<{ value: number; period: string } | null> {
  const data = await fetchEiaData("petroleum/pri/spt", { series: ["RBRTE"] }, "daily", 1);
  const latest = data[0];
  if (!latest || latest.value === null) return null;
  return { value: latest.value, period: latest.period };
}

/** U.S. regular gasoline retail price — latest ($/gallon, weekly). */
export async function fetchGasolineRetailPrice(): Promise<{ value: number; period: string } | null> {
  const data = await fetchEiaData(
    "petroleum/pri/gnd",
    { series: ["EMM_EPM0_PTE_NUS_DPG"] },
    "weekly",
    1
  );
  const latest = data[0];
  if (!latest || latest.value === null) return null;
  return { value: latest.value, period: latest.period };
}

/** Henry Hub / U.S. citygate natural gas price — latest ($/MMBtu, monthly). */
export async function fetchNaturalGasPrice(): Promise<{ value: number; period: string } | null> {
  const data = await fetchEiaData(
    "natural-gas/pri/sum",
    { duoarea: ["NUS"] },
    "monthly",
    1
  );
  const latest = data[0];
  if (!latest || latest.value === null) return null;
  return { value: latest.value, period: latest.period };
}

/** U.S. commercial crude oil inventories — latest (thousand barrels, weekly). */
export async function fetchCrudeInventories(): Promise<{ value: number; period: string } | null> {
  const data = await fetchEiaData(
    "petroleum/stoc/wstk",
    { series: ["WCESTUS1"] },
    "weekly",
    1
  );
  const latest = data[0];
  if (!latest || latest.value === null) return null;
  return { value: latest.value, period: latest.period };
}

/**
 * Fetch EIA energy time series for chart generation.
 * Returns chronologically ordered { labels, values } or null.
 */
export async function fetchEiaChartSeries(
  route: string,
  facets: Record<string, string[]>,
  frequency: "daily" | "weekly" | "monthly",
  length = 12
): Promise<{ labels: string[]; values: number[] } | null> {
  const data = await fetchEiaData(route, facets, frequency, length);
  if (data.length < 3) return null;

  // EIA returns desc — reverse for chronological order
  const chrono = [...data].reverse();

  return {
    labels: chrono.map((d) => d.period),
    values: chrono.map((d) => d.value ?? 0),
  };
}

/**
 * Convenience: fetch WTI 12-month chart series.
 */
export async function fetchWtiChartSeries(
  months = 12
): Promise<{ labels: string[]; values: number[] } | null> {
  // Use monthly average for cleaner charts
  return fetchEiaChartSeries(
    "petroleum/pri/spt",
    { series: ["RWTC"] },
    "monthly",
    months
  );
}

/**
 * Full energy data snapshot — called for energy/trade_policy topics.
 * Fetches WTI, Brent, gasoline, and nat gas in parallel.
 */
export async function fetchEnergySummary(): Promise<{
  wti: { value: number; period: string } | null;
  brent: { value: number; period: string } | null;
  gasoline: { value: number; period: string } | null;
  natGas: { value: number; period: string } | null;
}> {
  const [wti, brent, gasoline, natGas] = await Promise.allSettled([
    fetchWtiCrudePrice(),
    fetchBrentCrudePrice(),
    fetchGasolineRetailPrice(),
    fetchNaturalGasPrice(),
  ]);

  return {
    wti:      wti.status      === "fulfilled" ? wti.value      : null,
    brent:    brent.status    === "fulfilled" ? brent.value    : null,
    gasoline: gasoline.status === "fulfilled" ? gasoline.value : null,
    natGas:   natGas.status   === "fulfilled" ? natGas.value   : null,
  };
}

// ---------------------------------------------------------------------------
// SECTION 4 — FMP (Financial Modeling Prep)
// ---------------------------------------------------------------------------
//
// Key endpoints:
//   /api/v3/profile/{symbol}           — company profile (market cap, P/E, sector)
//   /api/v3/income-statement/{symbol}  — annual/quarterly income statement
//   /api/v3/key-metrics/{symbol}       — valuation metrics (P/E, EV/EBITDA, FCF yield)
//   /api/v3/earning_calendar           — upcoming earnings with estimates
//   /api/v3/earnings-surprises/{symbol}— historical beat/miss with magnitude
//   /api/v3/stock_news                 — recent news for a company
// ---------------------------------------------------------------------------

export interface FmpCompanyProfile {
  symbol: string;
  companyName: string;
  mktCap: number;
  price: number;
  changes: number;
  changesPercentage: number;
  exchange: string;
  industry: string;
  sector: string;
  description: string;
  pe: number;
  eps: number;
  beta: number;
  volAvg: number;
  lastDiv: number;
}

export interface FmpEarningCalendar {
  symbol: string;
  date: string;
  time?: string;           // "amc" | "bmo" | "dmh"
  eps?: number | null;
  epsEstimated?: number | null;
  revenue?: number | null;
  revenueEstimated?: number | null;
  fiscalDateEnding?: string;
  updatedFromDate?: string;
}

export interface FmpEarningsSurprise {
  date: string;
  symbol: string;
  actualEarningResult: number;
  estimatedEarning: number;
}

export interface FmpKeyMetrics {
  date: string;
  symbol: string;
  peRatio: number | null;
  priceToBookRatio: number | null;
  evToEbitda: number | null;
  freeCashFlowYield: number | null;
  debtToEquity: number | null;
  returnOnEquity: number | null;
  revenuePerShare: number | null;
}

export interface FmpStockNews {
  symbol: string;
  publishedDate: string;
  title: string;
  text: string;
  image: string;
  site: string;
  url: string;
}

function fmpUrl(path: string, params: Record<string, string> = {}): string {
  const apiKey = process.env.FMP_API_KEY ?? "";
  const base = `https://financialmodelingprep.com${path}`;
  const qs = new URLSearchParams({ ...params, apikey: apiKey }).toString();
  return `${base}?${qs}`;
}

/**
 * Fetch a real-time quote (price) for a symbol from FMP.
 * Used by data-fact-checker to verify S&P 500, VIX, DXY, and gold claims.
 * Returns the current price or null if unavailable.
 */
export async function fetchFmpQuote(
  symbol: string
): Promise<number | null> {
  if (!process.env.FMP_API_KEY) return null;

  try {
    const res = await fetch(
      fmpUrl(`/api/v3/quote/${symbol}`),
      { signal: withTimeout() }
    );
    if (!res.ok) return null;

    const data = await res.json();
    const quote = Array.isArray(data) ? data[0] : data;
    const price = quote?.price ?? quote?.close ?? null;
    return typeof price === "number" ? price : null;
  } catch (err) {
    logWarn("FMP", `quote fetch failed for ${symbol}: ${String(err)}`);
    return null;
  }
}

/**
 * Fetch daily stock price history from FMP for chart display.
 * Returns a chart-ready series with labels and closing prices.
 * Used by earnings articles to show the stock's performance around announcements.
 */
export async function fetchFmpStockHistory(
  symbol: string,
  days = 90,
): Promise<(ChartSeriesConfig & { labels: string[]; values: number[] }) | null> {
  if (!process.env.FMP_API_KEY) return null;

  try {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const to = new Date().toISOString().split("T")[0];

    // Stable API: /stable/historical-price-eod/full (required for accounts after Aug 2025)
    let historical: Array<{ date: string; close: number }> = [];

    const stableRes = await fetch(
      fmpUrl(`/stable/historical-price-eod/full`, { symbol, from, to }),
      { signal: withTimeout(15000) },
    ).catch(() => null);

    if (stableRes?.ok) {
      const stableData = await stableRes.json();
      historical = Array.isArray(stableData) ? stableData : (stableData?.historical ?? []);
    }

    // Fallback to Alpha Vantage if FMP returns no data (premium-only tickers)
    if (historical.length < 5 && process.env.ALPHAVANTAGE_API_KEY) {
      const avUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=compact&apikey=${process.env.ALPHAVANTAGE_API_KEY}`;
      const avRes = await fetch(avUrl, { signal: withTimeout(15000) }).catch(() => null);
      if (avRes?.ok) {
        const avData = await avRes.json();
        const timeSeries = avData?.["Time Series (Daily)"] ?? {};
        const entries = Object.entries(timeSeries)
          .map(([date, vals]) => ({
            date,
            close: parseFloat((vals as Record<string, string>)["4. close"] ?? "0"),
          }))
          .filter((e) => e.close > 0)
          .sort((a, b) => a.date.localeCompare(b.date)); // chronological

        // Filter to requested time range
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        historical = entries.filter((e) => e.date >= cutoff);
      }
    }

    if (historical.length < 5) return null;

    // Ensure chronological order
    const sorted = historical[0].date < historical[historical.length - 1].date
      ? historical
      : [...historical].reverse();
    const labels = sorted.map((d) => d.date);
    const values = sorted.map((d) => d.close);

    const source = historical.length > 0 && process.env.FMP_API_KEY
      ? "FMP — Financial Modeling Prep"
      : "Alpha Vantage";

    return {
      title: `${symbol} Stock Price`,
      unit: "$",
      source,
      timeRange: computeTimeRange(labels),
      type: "line",
      labels,
      values,
    };
  } catch (err) {
    console.error(`[market-data] Stock history failed for ${symbol}:`, err);
    return null;
  }
}

/**
 * Build a multi-series comparison chart: subject stock vs S&P 500 (SPY).
 * Both series are normalized to percentage change from the start date,
 * so a $100 stock and a 5000-point index can be meaningfully compared.
 * Returns a ChartDataset with `series` field for multi-line rendering.
 */
export async function buildComparisonChart(
  ticker: string,
  days = 90,
): Promise<ChartDataset | null> {
  if (!process.env.FMP_API_KEY && !process.env.ALPHAVANTAGE_API_KEY) return null;

  try {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const to = new Date().toISOString().split("T")[0];

    // Fetch historical data: FMP stable API first, Alpha Vantage fallback
    async function fetchHistory(symbol: string): Promise<Array<{ date: string; close: number }>> {
      // Try FMP first
      if (process.env.FMP_API_KEY) {
        const res = await fetch(
          fmpUrl(`/stable/historical-price-eod/full`, { symbol, from, to }),
          { signal: withTimeout(15000) },
        ).catch(() => null);
        if (res?.ok) {
          const d = await res.json();
          const hist = Array.isArray(d) ? d : (d?.historical ?? []);
          if (hist.length >= 10) return hist;
        }
      }
      // Alpha Vantage fallback
      if (process.env.ALPHAVANTAGE_API_KEY) {
        const avUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=compact&apikey=${process.env.ALPHAVANTAGE_API_KEY}`;
        const avRes = await fetch(avUrl, { signal: withTimeout(15000) }).catch(() => null);
        if (avRes?.ok) {
          const avData = await avRes.json();
          const ts = avData?.["Time Series (Daily)"] ?? {};
          return Object.entries(ts)
            .map(([date, vals]) => ({
              date,
              close: parseFloat((vals as Record<string, string>)["4. close"] ?? "0"),
            }))
            .filter((e) => e.close > 0 && e.date >= from)
            .sort((a, b) => a.date.localeCompare(b.date));
        }
      }
      return [];
    }

    // Fetch both in parallel
    const [stockHist, spyHist] = await Promise.all([
      fetchHistory(ticker),
      fetchHistory("SPY"),
    ]);

    if (stockHist.length < 10 || spyHist.length < 10) return null;

    // Reverse to chronological (oldest first)
    const stockSorted = [...stockHist].reverse();
    const spySorted = [...spyHist].reverse();

    // Build a date → close map for SPY for alignment
    const spyMap = new Map(spySorted.map((d) => [d.date, d.close]));

    // Align: only include dates where BOTH have data
    const aligned: { date: string; stock: number; spy: number }[] = [];
    for (const pt of stockSorted) {
      const spyClose = spyMap.get(pt.date);
      if (spyClose !== undefined) {
        aligned.push({ date: pt.date, stock: pt.close, spy: spyClose });
      }
    }

    if (aligned.length < 10) return null;

    // Normalize to % change from first point
    const stockBase = aligned[0].stock;
    const spyBase = aligned[0].spy;

    const labels = aligned.map((d) => d.date);
    const stockPctChange = aligned.map((d) => ((d.stock - stockBase) / stockBase) * 100);
    const spyPctChange = aligned.map((d) => ((d.spy - spyBase) / spyBase) * 100);

    const lastStockPct = stockPctChange[stockPctChange.length - 1];
    const lastSpyPct = spyPctChange[spyPctChange.length - 1];

    const outperformance = lastStockPct - lastSpyPct;
    const outStr = outperformance >= 0
      ? `outperforming the S&P 500 by ${outperformance.toFixed(1)}pp`
      : `underperforming the S&P 500 by ${Math.abs(outperformance).toFixed(1)}pp`;

    return {
      title: `${ticker} vs S&P 500 — Relative Performance`,
      type: "line",
      labels,
      values: stockPctChange, // backward-compat primary
      unit: "pp",
      source: "FMP — Financial Modeling Prep",
      timeRange: computeTimeRange(labels),
      chartLabel: "PERFORMANCE",
      insertAfterParagraph: 1,
      caption: `${ticker} ${lastStockPct >= 0 ? "+" : ""}${lastStockPct.toFixed(1)}% vs S&P 500 ${lastSpyPct >= 0 ? "+" : ""}${lastSpyPct.toFixed(1)}% over the period, ${outStr}.`,
      referenceValue: 0,
      referenceLabel: "Start",
      series: [
        { name: ticker, values: stockPctChange, color: "#22C55E" },
        { name: "S&P 500", values: spyPctChange, color: "#64748b" },
      ],
    };
  } catch (err) {
    console.error(`[market-data] Comparison chart failed for ${ticker}:`, err);
    return null;
  }
}

/**
 * Fetch company profile (market cap, price, P/E, sector, description).
 * Returns null if FMP_API_KEY is absent or request fails.
 */
export async function fetchFmpCompanyProfile(
  symbol: string
): Promise<FmpCompanyProfile | null> {
  if (!process.env.FMP_API_KEY) return null;

  try {
    const res = await fetch(fmpUrl(`/api/v3/profile/${symbol}`), { signal: withTimeout() });
    if (!res.ok) return null;

    const data: FmpCompanyProfile[] = await res.json();
    return data?.[0] ?? null;
  } catch (err) {
    logWarn("FMP", `profile fetch failed for ${symbol}: ${String(err)}`);
    return null;
  }
}

/**
 * Fetch earnings calendar for the next N days.
 * Returns [] if FMP_API_KEY is absent or request fails.
 */
export async function fetchFmpEarningsCalendar(
  daysAhead = 7
): Promise<FmpEarningCalendar[]> {
  if (!process.env.FMP_API_KEY) return [];

  try {
    const from = new Date().toISOString().split("T")[0];
    const to = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const res = await fetch(
      fmpUrl("/api/v3/earning_calendar", { from, to }),
      { signal: withTimeout() }
    );
    if (!res.ok) return [];

    const data: FmpEarningCalendar[] = await res.json();
    return Array.isArray(data) ? data.slice(0, 15) : [];
  } catch (err) {
    logWarn("FMP", `earnings calendar failed: ${String(err)}`);
    return [];
  }
}

/**
 * Fetch earnings surprises (beat/miss history) for a specific company.
 * Returns [] if unavailable.
 */
export async function fetchFmpEarningsSurprises(
  symbol: string,
  limit = 4
): Promise<FmpEarningsSurprise[]> {
  if (!process.env.FMP_API_KEY) return [];

  try {
    const res = await fetch(
      fmpUrl(`/api/v3/earnings-surprises/${symbol}`),
      { signal: withTimeout() }
    );
    if (!res.ok) return [];

    const data: FmpEarningsSurprise[] = await res.json();
    return Array.isArray(data) ? data.slice(0, limit) : [];
  } catch (err) {
    logWarn("FMP", `earnings surprises failed for ${symbol}: ${String(err)}`);
    return [];
  }
}

/**
 * Fetch key valuation metrics for a company (P/E, EV/EBITDA, FCF yield).
 * Returns null if unavailable.
 */
export async function fetchFmpKeyMetrics(
  symbol: string
): Promise<FmpKeyMetrics | null> {
  if (!process.env.FMP_API_KEY) return null;

  try {
    const res = await fetch(
      fmpUrl(`/api/v3/key-metrics/${symbol}`, { period: "quarter", limit: "1" }),
      { signal: withTimeout() }
    );
    if (!res.ok) return null;

    const data: FmpKeyMetrics[] = await res.json();
    return data?.[0] ?? null;
  } catch (err) {
    logWarn("FMP", `key metrics failed for ${symbol}: ${String(err)}`);
    return null;
  }
}

/**
 * Fetch recent company news from FMP (useful for discovery and evidence enrichment).
 * Returns [] if unavailable.
 */
export async function fetchFmpStockNews(
  symbol: string,
  limit = 5
): Promise<FmpStockNews[]> {
  if (!process.env.FMP_API_KEY) return [];

  try {
    const res = await fetch(
      fmpUrl("/api/v3/stock_news", { tickers: symbol, limit: String(limit) }),
      { signal: withTimeout() }
    );
    if (!res.ok) return [];

    const data: FmpStockNews[] = await res.json();
    return Array.isArray(data) ? data.slice(0, limit) : [];
  } catch (err) {
    logWarn("FMP", `stock news failed for ${symbol}: ${String(err)}`);
    return [];
  }
}

/**
 * Format an earnings beat/miss as a human-readable string.
 * e.g. "beat by $0.12 (14%)"
 */
export function formatEarningsSurprise(s: FmpEarningsSurprise): string {
  const diff = s.actualEarningResult - s.estimatedEarning;
  const pct = s.estimatedEarning !== 0
    ? Math.abs((diff / s.estimatedEarning) * 100).toFixed(1)
    : "N/A";
  const direction = diff >= 0 ? "beat" : "missed";
  return `${direction} by $${Math.abs(diff).toFixed(2)} (${pct}%)`;
}

// ---------------------------------------------------------------------------
// SECTION 5 — Alpha Vantage (market quotes)
// ---------------------------------------------------------------------------

interface AlphaVantageQuote {
  "Global Quote"?: {
    "05. price"?: string;
    "09. change"?: string;
    "10. change percent"?: string;
    "07. latest trading day"?: string;
  };
}

/** Fetch current stock quote from Alpha Vantage. Returns null if unavailable. */
export async function fetchStockQuote(
  symbol: string
): Promise<{ price: string; change: string; changePercent: string } | null> {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) return null;

  try {
    const url =
      `https://www.alphavantage.co/query` +
      `?function=GLOBAL_QUOTE` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&apikey=${apiKey}`;

    const res = await fetch(url, { signal: withTimeout() });
    if (!res.ok) return null;

    const data: AlphaVantageQuote = await res.json();
    const quote = data["Global Quote"];
    if (!quote?.["05. price"]) return null;

    return {
      price: `$${parseFloat(quote["05. price"]).toFixed(2)}`,
      change: quote["09. change"] ?? "0",
      changePercent: quote["10. change percent"] ?? "0%",
    };
  } catch (err) {
    logWarn("AlphaVantage", `quote failed for ${symbol}: ${String(err)}`);
    return null;
  }
}

interface AlphaVantageCurrencyRate {
  "Realtime Currency Exchange Rate"?: {
    "5. Exchange Rate"?: string;
    "6. Last Refreshed"?: string;
  };
}

/** Fetch Bitcoin price in USD via Alpha Vantage CURRENCY_EXCHANGE_RATE. Returns null if unavailable. */
export async function fetchBitcoinPrice(): Promise<{ price: number; updatedAt: string } | null> {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) return null;

  try {
    const url =
      `https://www.alphavantage.co/query` +
      `?function=CURRENCY_EXCHANGE_RATE` +
      `&from_currency=BTC` +
      `&to_currency=USD` +
      `&apikey=${apiKey}`;

    const res = await fetch(url, { signal: withTimeout() });
    if (!res.ok) return null;

    const data: AlphaVantageCurrencyRate = await res.json();
    const rate = data["Realtime Currency Exchange Rate"];
    if (!rate?.["5. Exchange Rate"]) return null;

    const price = parseFloat(rate["5. Exchange Rate"]);
    if (isNaN(price)) return null;

    return {
      price,
      updatedAt: rate["6. Last Refreshed"] ?? new Date().toISOString(),
    };
  } catch (err) {
    logWarn("AlphaVantage", `Bitcoin price fetch failed: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// SECTION 6 — Polygon (optional advanced tick data)
// ---------------------------------------------------------------------------

interface PolygonPrevClose {
  results?: Array<{ c: number; o: number; h: number; l: number; vw: number; t: number }>;
}

/** Fetch previous close for a ticker. Returns null if Polygon key absent. */
export async function fetchPrevClose(
  ticker: string
): Promise<{ close: number; open: number; high: number; low: number } | null> {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  try {
    const url =
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev` +
      `?adjusted=true&apiKey=${apiKey}`;

    const res = await fetch(url, { signal: withTimeout() });
    if (!res.ok) return null;

    const data: PolygonPrevClose = await res.json();
    const r = data.results?.[0];
    if (!r) return null;

    return { close: r.c, open: r.o, high: r.h, low: r.l };
  } catch (err) {
    logWarn("Polygon", `prev close failed for ${ticker}: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// SECTION 7 — Evidence Layer: fetchContextualData
// ---------------------------------------------------------------------------
//
// Central entry point for the news synthesis pipeline.
// Maps each topic key to the most relevant API calls and returns
// an array of KeyDataPoints to include in the Claude evidence packet.
//
// All API calls run in parallel with Promise.allSettled so one
// slow/failed API never blocks the others.
// ---------------------------------------------------------------------------

/**
 * Fetch a set of market data points relevant to a topic.
 * Returns up to ~5 KeyDataPoints; always returns [] on total failure.
 * This is the primary integration point for the evidence layer.
 *
 * Environment variables used (all optional, degrade gracefully):
 *   FRED_API_KEY, BLS_API_KEY, EIA_API_KEY, ALPHAVANTAGE_API_KEY, FMP_API_KEY
 */
export async function fetchContextualData(
  topicKey: string,
  /** Optional ticker for company-specific data enrichment */
  ticker?: string,
): Promise<KeyDataPoint[]> {
  const points: KeyDataPoint[] = [];

  try {
    // ── Company-specific data (any article with an identified subject) ────
    // Fetch market cap, P/E, 52-week performance from FMP before topic-level
    // data. These appear first in the key data strip, giving each article a
    // unique identity instead of generic macro numbers.
    if (ticker && process.env.FMP_API_KEY) {
      try {
        const profile = await fetchFmpCompanyProfile(ticker);
        if (profile) {
          if (profile.mktCap) {
            const capB = (profile.mktCap / 1e9).toFixed(1);
            points.push({ label: `${ticker} Market Cap`, value: `$${capB}B`, source: "FMP" });
          }
          if (profile.price) {
            const changeStr = profile.changes != null
              ? ` (${profile.changes >= 0 ? "+" : ""}${profile.changes.toFixed(2)}%)`
              : "";
            points.push({ label: `${ticker} Price`, value: `$${profile.price.toFixed(2)}${changeStr}`, source: "FMP" });
          }
          if (profile.pe) {
            points.push({ label: `${ticker} P/E`, value: profile.pe.toFixed(1), source: "FMP" });
          }
          if (profile.sector) {
            points.push({ label: "Sector", value: profile.sector, source: "FMP" });
          }
        }
      } catch {
        // Company data is supplemental — don't block on failure
      }
    }

    switch (topicKey) {

      // ── Federal Reserve / monetary policy ──────────────────────────────
      case "federal_reserve":
      case "fed_macro": {
        const [fedfunds, treasury10y, treasury2y, cpiYoyBls, cpiYoyFred] = await Promise.allSettled([
          fetchFredWithChange("FEDFUNDS"),
          fetchTreasuryYieldWithChange("DGS10"),
          fetchFredWithChange("DGS2"),
          fetchBlsMultipleSeries([BLS_SERIES.CPI_ALL], 2),
          fetchFredSeries("CPIAUCSL", 18),
        ]);

        if (fedfunds.status === "fulfilled" && fedfunds.value)
          points.push({ label: "Fed Funds Rate", value: `${fedfunds.value.value}%`, change: fedfunds.value.change || undefined, source: "FRED" });
        if (treasury10y.status === "fulfilled" && treasury10y.value)
          points.push({ label: "10-Year Treasury", value: `${treasury10y.value.value}%`, change: treasury10y.value.change || undefined, source: "FRED" });
        if (treasury2y.status === "fulfilled" && treasury2y.value)
          points.push({ label: "2-Year Treasury", value: `${treasury2y.value.value}%`, change: treasury2y.value.change || undefined, source: "FRED" });

        // CPI YoY % (BLS primary, FRED fallback) — never raw index
        let cpiYoy: string | null = null;
        if (cpiYoyBls.status === "fulfilled") {
          const obs = cpiYoyBls.value[BLS_SERIES.CPI_ALL];
          if (obs && obs.length >= 13) {
            const latest = parseFloat(obs[0].value);
            const yearAgo = parseFloat(obs[12].value);
            if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
              cpiYoy = ((latest - yearAgo) / yearAgo * 100).toFixed(1);
            }
          }
        }
        if (!cpiYoy && cpiYoyFred.status === "fulfilled") {
          const obs = cpiYoyFred.value;
          if (obs && obs.length >= 13) {
            const latest = parseFloat(obs[0].value);
            const yearAgo = parseFloat(obs[12].value);
            if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
              cpiYoy = ((latest - yearAgo) / yearAgo * 100).toFixed(1);
            }
          }
        }
        if (cpiYoy) {
          points.push({ label: "CPI YoY", value: `${cpiYoy}%`, source: "BLS" });
        }
        break;
      }

      // ── Inflation ───────────────────────────────────────────────────────
      // RULE: Always return YoY percentages, NEVER raw index levels.
      // Raw CPI index values (e.g., "326.785") are meaningless to readers.
      case "inflation": {
        const [blsResult, fredCpiSeries] = await Promise.allSettled([
          fetchBlsMultipleSeries([BLS_SERIES.CPI_ALL, BLS_SERIES.CPI_CORE, BLS_SERIES.PPI_FINISHED], 2),
          fetchFredSeries("CPIAUCSL", 18),
        ]);

        // CPI All Items YoY %
        if (blsResult.status === "fulfilled") {
          const bls = blsResult.value;
          const cpiAll = bls[BLS_SERIES.CPI_ALL];
          if (cpiAll && cpiAll.length >= 13) {
            const latest = parseFloat(cpiAll[0].value);
            const yearAgo = parseFloat(cpiAll[12].value);
            if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
              points.push({ label: "CPI YoY", value: `${((latest - yearAgo) / yearAgo * 100).toFixed(1)}%`, source: "BLS" });
            }
          }
          // Core CPI YoY %
          const cpiCore = bls[BLS_SERIES.CPI_CORE];
          if (cpiCore && cpiCore.length >= 13) {
            const latest = parseFloat(cpiCore[0].value);
            const yearAgo = parseFloat(cpiCore[12].value);
            if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
              points.push({ label: "Core CPI YoY", value: `${((latest - yearAgo) / yearAgo * 100).toFixed(1)}%`, source: "BLS" });
            }
          }
          // PPI YoY %
          const ppi = bls[BLS_SERIES.PPI_FINISHED];
          if (ppi && ppi.length >= 13) {
            const latest = parseFloat(ppi[0].value);
            const yearAgo = parseFloat(ppi[12].value);
            if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
              points.push({ label: "PPI YoY", value: `${((latest - yearAgo) / yearAgo * 100).toFixed(1)}%`, source: "BLS" });
            }
          }
        }

        // FRED fallback for CPI YoY if BLS unavailable
        if (points.length === 0 && fredCpiSeries.status === "fulfilled") {
          const obs = fredCpiSeries.value;
          if (obs && obs.length >= 13) {
            const latest = parseFloat(obs[0].value);
            const yearAgo = parseFloat(obs[12].value);
            if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
              points.push({ label: "CPI YoY", value: `${((latest - yearAgo) / yearAgo * 100).toFixed(1)}%`, source: "FRED" });
            }
          }
        }
        break;
      }

      // ── Employment / labor market ───────────────────────────────────────
      case "employment": {
        const blsMacro = await fetchBlsMacroSummary();
        if (blsMacro.unemployment)
          points.push({ label: "Unemployment Rate", value: `${blsMacro.unemployment.value}%`, source: "BLS" });
        if (blsMacro.payrolls) {
          const m = parseFloat(blsMacro.payrolls.value);
          points.push({ label: "Nonfarm Payrolls", value: `${(m / 1000).toFixed(1)}M`, source: "BLS" });
        }
        if (blsMacro.wages)
          points.push({ label: "Avg Hourly Wages", value: `$${parseFloat(blsMacro.wages.value).toFixed(2)}`, source: "BLS" });

        // Also grab unemployment FRED backup
        const unrate = await fetchFredLatest("UNRATE");
        if (unrate && points.length === 0)
          points.push({ label: "Unemployment Rate", value: `${unrate.value}%`, source: "FRED" });
        break;
      }

      // ── GDP / economic growth ───────────────────────────────────────────
      case "gdp": {
        const [gdp, gdpGrowth, fedfunds] = await Promise.allSettled([
          fetchFredLatest("GDP"),
          fetchFredLatest("A191RL1Q225SBEA"),  // Real GDP growth rate (%)
          fetchFredLatest("FEDFUNDS"),
        ]);

        if (gdp.status === "fulfilled" && gdp.value) {
          const b = parseFloat(gdp.value.value);
          points.push({ label: "Real GDP", value: `$${(b / 1000).toFixed(1)}T`, source: "FRED" });
        }
        if (gdpGrowth.status === "fulfilled" && gdpGrowth.value)
          points.push({ label: "Real GDP Growth", value: `${gdpGrowth.value.value}%`, source: "FRED" });
        if (fedfunds.status === "fulfilled" && fedfunds.value)
          points.push({ label: "Fed Funds Rate", value: `${fedfunds.value.value}%`, source: "FRED" });
        break;
      }

      // ── Bond market / yield curve ───────────────────────────────────────
      case "bond_market": {
        const [t10y, t2y, t30y, fedfunds] = await Promise.allSettled([
          fetchTreasuryYieldWithChange("DGS10"),
          fetchFredWithChange("DGS2"),
          fetchTreasuryYieldWithChange("DGS30"),
          fetchFredWithChange("FEDFUNDS"),
        ]);

        if (t10y.status === "fulfilled" && t10y.value)
          points.push({ label: "10-Year Yield", value: `${t10y.value.value}%`, change: t10y.value.change || undefined, source: t10y.value.source });
        if (t2y.status === "fulfilled" && t2y.value)
          points.push({ label: "2-Year Yield", value: `${t2y.value.value}%`, change: t2y.value.change || undefined, source: "FRED" });
        if (t30y.status === "fulfilled" && t30y.value)
          points.push({ label: "30-Year Yield", value: `${t30y.value.value}%`, change: t30y.value.change || undefined, source: t30y.value.source });
        if (fedfunds.status === "fulfilled" && fedfunds.value)
          points.push({ label: "Fed Funds Rate", value: `${fedfunds.value.value}%`, change: fedfunds.value.change || undefined, source: "FRED" });
        break;
      }

      // ── Energy & commodities ─────────────────────────────────────────────
      case "energy": {
        const energy = await fetchEnergySummary();
        if (energy.wti)
          points.push({ label: "WTI Crude", value: `$${energy.wti.value.toFixed(2)}/bbl`, source: "EIA" });
        if (energy.brent)
          points.push({ label: "Brent Crude", value: `$${energy.brent.value.toFixed(2)}/bbl`, source: "EIA" });
        if (energy.gasoline)
          points.push({ label: "U.S. Gasoline (avg)", value: `$${energy.gasoline.value.toFixed(3)}/gal`, source: "EIA" });
        if (energy.natGas)
          points.push({ label: "Henry Hub Nat Gas", value: `$${energy.natGas.value.toFixed(2)}/MMBtu`, source: "EIA" });
        break;
      }

      // ── Trade policy (often energy/commodity sensitive) ─────────────────
      case "trade_policy": {
        const [energy, treasury10y] = await Promise.allSettled([
          fetchEnergySummary(),
          fetchTreasuryYieldWithChange("DGS10"),
        ]);
        if (energy.status === "fulfilled") {
          if (energy.value.wti)
            points.push({ label: "WTI Crude", value: `$${energy.value.wti.value.toFixed(2)}/bbl`, source: "EIA" });
          if (energy.value.brent)
            points.push({ label: "Brent Crude", value: `$${energy.value.brent.value.toFixed(2)}/bbl`, source: "EIA" });
        }
        if (treasury10y.status === "fulfilled" && treasury10y.value)
          points.push({ label: "10-Year Treasury", value: `${treasury10y.value.value}%`, source: treasury10y.value.source });
        break;
      }

      // ── Earnings ─────────────────────────────────────────────────────────
      case "earnings": {
        const upcomingEarnings = await fetchFmpEarningsCalendar(7);
        // Convert upcoming earnings into key data points
        const topEarnings = upcomingEarnings
          .filter((e) => e.revenueEstimated && e.revenueEstimated > 1_000_000_000) // >$1B revenue
          .slice(0, 3);

        for (const e of topEarnings) {
          const revB = e.revenueEstimated ? (e.revenueEstimated / 1e9).toFixed(1) : null;
          const epsStr = e.epsEstimated ? `EPS est. $${e.epsEstimated.toFixed(2)}` : null;
          const detail = [revB ? `Rev est. $${revB}B` : null, epsStr].filter(Boolean).join(", ");
          points.push({
            label: `${e.symbol} earnings (${e.date})`,
            value: detail || "upcoming",
            source: "FMP",
          });
        }

        // Add market context from Alpha Vantage
        const spy = await fetchStockQuote("SPY");
        if (spy)
          points.push({ label: "S&P 500 ETF (SPY)", value: spy.price, change: spy.changePercent, source: "Alpha Vantage" });
        break;
      }

      // ── Broad market / general market moves ──────────────────────────────
      case "broad_market":
      case "markets": {
        const [spy, qqq, vix] = await Promise.allSettled([
          fetchStockQuote("SPY"),
          fetchStockQuote("QQQ"),
          fetchStockQuote("VIX"),
        ]);
        if (spy.status === "fulfilled" && spy.value)
          points.push({ label: "S&P 500 ETF (SPY)", value: spy.value.price, change: spy.value.changePercent, source: "Alpha Vantage" });
        if (qqq.status === "fulfilled" && qqq.value)
          points.push({ label: "Nasdaq ETF (QQQ)", value: qqq.value.price, change: qqq.value.changePercent, source: "Alpha Vantage" });
        if (vix.status === "fulfilled" && vix.value)
          points.push({ label: "VIX", value: vix.value.price, source: "Alpha Vantage" });

        // Add treasury yield context
        const t10y = await fetchTreasuryYieldWithChange("DGS10");
        if (t10y)
          points.push({ label: "10-Year Treasury", value: `${t10y.value}%`, source: t10y.source });
        break;
      }

      // ── Crypto ────────────────────────────────────────────────────────────
      case "crypto": {
        const [btc, eth] = await Promise.allSettled([
          fetchStockQuote("BTC-USD"),
          fetchStockQuote("ETH-USD"),
        ]);
        if (btc.status === "fulfilled" && btc.value)
          points.push({ label: "Bitcoin (BTC)", value: btc.value.price, change: btc.value.changePercent, source: "Alpha Vantage" });
        if (eth.status === "fulfilled" && eth.value)
          points.push({ label: "Ethereum (ETH)", value: eth.value.price, change: eth.value.changePercent, source: "Alpha Vantage" });
        break;
      }

      // ── M&A / bankruptcy ─────────────────────────────────────────────────
      case "merger_acquisition":
      case "bankruptcy": {
        const [t10y, spy] = await Promise.allSettled([
          fetchTreasuryYieldWithChange("DGS10"),
          fetchStockQuote("SPY"),
        ]);
        if (t10y.status === "fulfilled" && t10y.value)
          points.push({ label: "10-Year Yield", value: `${t10y.value.value}%`, source: t10y.value.source });
        if (spy.status === "fulfilled" && spy.value)
          points.push({ label: "S&P 500 ETF (SPY)", value: spy.value.price, change: spy.value.changePercent, source: "Alpha Vantage" });
        break;
      }

      // ── Default: macro summary ─────────────────────────────────────────
      default: {
        const [fedfunds, t10y] = await Promise.allSettled([
          fetchFredLatest("FEDFUNDS"),
          fetchTreasuryYieldWithChange("DGS10"),
        ]);
        if (fedfunds.status === "fulfilled" && fedfunds.value)
          points.push({ label: "Fed Funds Rate", value: `${fedfunds.value.value}%`, source: "FRED" });
        if (t10y.status === "fulfilled" && t10y.value)
          points.push({ label: "10-Year Treasury", value: `${t10y.value.value}%`, source: t10y.value.source });
        break;
      }
    }
  } catch (err) {
    // Never let market data failures break the synthesis pipeline
    logWarn("contextual", `fetchContextualData failed for ${topicKey}: ${String(err)}`);
  }

  // ── Safeguard: scrub raw CPI index values that slipped through ──────────
  // Raw BLS index levels (e.g., "326.785") are never meaningful to readers.
  // This is a last-resort defense; the cases above should already compute YoY.
  return sanitizeKeyDataPoints(points).slice(0, 5); // Cap at 5 data points per story
}

/**
 * Safeguard: remove or flag any KeyDataPoint containing a raw CPI/PPI index
 * value (a bare 2-3 digit decimal like "326.785" without a % or $ prefix).
 * This ensures no raw BLS index levels reach articles or briefings.
 */
export function sanitizeKeyDataPoints(points: KeyDataPoint[]): KeyDataPoint[] {
  const RAW_INDEX_PATTERN = /^\d{2,3}\.\d+$/;
  return points.filter((dp) => {
    const cleanValue = dp.value.replace(/[,$\s]/g, "");
    const isCpiPpi = /cpi|ppi|inflation.*index/i.test(dp.label);
    if (isCpiPpi && RAW_INDEX_PATTERN.test(cleanValue)) {
      console.warn(`[safeguard] Scrubbed raw index value: "${dp.label}" = "${dp.value}" — use YoY % instead`);
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// SECTION 7b — Morning Brief Macro Panel
// ---------------------------------------------------------------------------
//
// Dedicated function for the Morning Brief "Key Data" sidebar.
// Returns exactly 6 institutional-grade macro indicators:
//   1. Fed Funds Rate     — policy anchor
//   2. 10-Year Treasury   — duration benchmark (change in bps)
//   3. 2s–10s Spread      — yield curve shape / recession signal
//   4. CPI YoY %          — the inflation figure markets actually track
//   5. WTI Crude Oil      — energy / inflation expectations proxy
//   6. Dollar Index (DXY) — global risk / carry trade signal
//
// This replaces the old approach of calling fetchContextualData("federal_reserve")
// + fetchContextualData("bond_market") which produced duplicate yields and a
// useless raw CPI index level.
// ---------------------------------------------------------------------------

export async function fetchBriefingMacroPanel(): Promise<KeyDataPoint[]> {
  const points: KeyDataPoint[] = [];

  try {
    // Fetch all data sources in parallel for speed
    // WTI: EIA primary → FRED DCOILWTICO fallback (EIA_API_KEY often not set)
    const [
      fedfunds,
      treasury10y,
      spread2s10s,
      cpiDataBls,
      cpiDataFred,
      energy,
      wtiFredFallback,
      yahooDxy,
      yahooWti,
    ] = await Promise.allSettled([
      fetchFredWithChange("FEDFUNDS"),
      fetchTreasuryYieldWithChange("DGS10"),  // Yahoo → FRED cascade for same-day 10Y
      fetchFredWithChange("T10Y2Y"),          // 10Y minus 2Y spread (FRED series)
      fetchBlsMultipleSeries([BLS_SERIES.CPI_ALL], 2),  // BLS CPI for YoY calc (primary)
      fetchFredSeries("CPIAUCSL", 18),                  // FRED CPI fallback (18 months)
      fetchEnergySummary(),
      fetchFredWithChange("DCOILWTICO"),      // FRED WTI fallback when EIA key missing
      fetchYahooYield("DX-Y.NYB"),            // ICE Dollar Index (~99) via Yahoo
      fetchYahooYield("CL=F"),                // WTI crude futures via Yahoo
    ]);

    // 1. Fed Funds Rate — omit "+0.00" noise (rate changes are discrete events)
    if (fedfunds.status === "fulfilled" && fedfunds.value) {
      const change = fedfunds.value.change;
      const showChange = change && change !== "+0.00" && change !== "0.00";
      points.push({
        label: "Fed Funds Rate",
        value: `${fedfunds.value.value}%`,
        change: showChange ? change : undefined,
        source: "FRED",
      });
    }

    // 2. 10-Year Treasury — format change as basis points (e.g., "+6 bps")
    if (treasury10y.status === "fulfilled" && treasury10y.value) {
      const rawChange = parseFloat(treasury10y.value.change || "0");
      const bpsChange = !isNaN(rawChange) && rawChange !== 0
        ? `${rawChange > 0 ? "+" : ""}${Math.round(rawChange * 100)} bps`
        : undefined;
      points.push({
        label: "10-Year Treasury",
        value: `${treasury10y.value.value}%`,
        change: bpsChange,
        source: treasury10y.value.source,
      });
    }

    // 3. 2s–10s Spread — yield curve inversion/steepening signal
    if (spread2s10s.status === "fulfilled" && spread2s10s.value) {
      const val = parseFloat(spread2s10s.value.value);
      const rawChange = parseFloat(spread2s10s.value.change || "0");
      const bpsChange = !isNaN(rawChange) && rawChange !== 0
        ? `${rawChange > 0 ? "+" : ""}${Math.round(rawChange * 100)} bps`
        : undefined;
      points.push({
        label: "2s–10s Spread",
        value: `${val >= 0 ? "+" : ""}${spread2s10s.value.value}%`,
        change: bpsChange,
        source: "FRED",
      });
    }

    // 4. CPI YoY % — BLS primary, FRED CPIAUCSL fallback
    //    Compute year-over-year from index values (latest vs 12 months ago)
    let cpiAdded = false;
    if (cpiDataBls.status === "fulfilled") {
      const cpiPoints = cpiDataBls.value[BLS_SERIES.CPI_ALL];
      if (cpiPoints && cpiPoints.length >= 13) {
        // BLS returns newest first — index 0 is latest, index 12 is 12 months ago
        const latest = parseFloat(cpiPoints[0].value);
        const yearAgo = parseFloat(cpiPoints[12].value);
        if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
          const yoy = ((latest - yearAgo) / yearAgo * 100);
          points.push({ label: "CPI YoY", value: `${yoy.toFixed(1)}%`, source: "BLS" });
          cpiAdded = true;
        }
      }
    }
    if (!cpiAdded && cpiDataFred.status === "fulfilled") {
      // FRED returns newest first — need index 0 (latest) and ~index 12 (12 months ago)
      const fredCpi = cpiDataFred.value;
      if (fredCpi.length >= 13) {
        const latest = parseFloat(fredCpi[0].value);
        const yearAgo = parseFloat(fredCpi[12].value);
        if (!isNaN(latest) && !isNaN(yearAgo) && yearAgo > 0) {
          const yoy = ((latest - yearAgo) / yearAgo * 100);
          points.push({ label: "CPI YoY", value: `${yoy.toFixed(1)}%`, source: "FRED" });
          cpiAdded = true;
        }
      }
    }

    // 5. WTI Crude Oil — EIA primary → Yahoo CL=F → FRED DCOILWTICO fallback
    if (energy.status === "fulfilled" && energy.value.wti) {
      points.push({
        label: "WTI Crude",
        value: `$${energy.value.wti.value.toFixed(2)}/bbl`,
        source: "EIA",
      });
    } else if (yahooWti.status === "fulfilled" && yahooWti.value) {
      const price = parseFloat(yahooWti.value.value);
      if (!isNaN(price)) {
        const rawChange = parseFloat(yahooWti.value.change || "0");
        const pctChange = !isNaN(rawChange) && price > 0 && rawChange !== 0
          ? `${rawChange > 0 ? "+" : ""}${((rawChange / (price - rawChange)) * 100).toFixed(1)}%`
          : undefined;
        points.push({
          label: "WTI Crude",
          value: `$${price.toFixed(2)}/bbl`,
          change: pctChange,
          source: "Yahoo",
        });
      }
    } else if (wtiFredFallback.status === "fulfilled" && wtiFredFallback.value) {
      const price = parseFloat(wtiFredFallback.value.value);
      if (!isNaN(price)) {
        const rawChange = parseFloat(wtiFredFallback.value.change || "0");
        const pctChange = !isNaN(rawChange) && price > 0 && rawChange !== 0
          ? `${rawChange > 0 ? "+" : ""}${((rawChange / (price - rawChange)) * 100).toFixed(1)}%`
          : undefined;
        points.push({
          label: "WTI Crude",
          value: `$${price.toFixed(2)}/bbl`,
          change: pctChange,
          source: "FRED",
        });
      }
    }

    // 6. Dollar Index — Yahoo ICE DXY (~99), NOT FRED DTWEXBGS (~120)
    if (yahooDxy.status === "fulfilled" && yahooDxy.value) {
      const rawChange = parseFloat(yahooDxy.value.change || "0");
      const changeStr = !isNaN(rawChange) && rawChange !== 0
        ? `${rawChange > 0 ? "+" : ""}${rawChange.toFixed(2)}`
        : undefined;
      points.push({
        label: "Dollar Index",
        value: yahooDxy.value.value,
        change: changeStr,
        source: "Yahoo",
      });
    }
  } catch (err) {
    logWarn("briefing-macro", `fetchBriefingMacroPanel failed: ${String(err)}`);
  }

  return points;
}

// ---------------------------------------------------------------------------
// SECTION 8 — Chart series factory for synthesis pipeline
// ---------------------------------------------------------------------------
//
// Maps topic keys to specific API + series combinations.
// Returns a chart-ready { labels, values } or null.
// Called by news-synthesis.ts buildChartData().
// ---------------------------------------------------------------------------

export interface ChartSeriesConfig {
  title: string;
  unit: string;
  source: string;
  timeRange: string;
  type: "line" | "bar";
}

/**
 * Convert a CPI index time series into year-over-year % change.
 * Requires at least 13 data points (12 months + 1 prior-year anchor).
 * Returns null if insufficient data.
 */
function computeYoyChange(
  labels: string[],
  values: number[],
  decimals = 1
): { labels: string[]; values: number[] } | null {
  if (values.length < 13) return null;

  const yoyLabels: string[] = [];
  const yoyValues: number[] = [];

  for (let i = 12; i < values.length; i++) {
    const current = values[i];
    const prevYear = values[i - 12];
    if (!prevYear || isNaN(current) || isNaN(prevYear)) continue;

    yoyValues.push(parseFloat(((current - prevYear) / prevYear * 100).toFixed(decimals)));
    yoyLabels.push(labels[i]);
  }

  return yoyValues.length >= 3 ? { labels: yoyLabels, values: yoyValues } : null;
}

/**
 * Compute a human-readable time range label from actual date labels.
 * E.g., 90 daily observations from Nov 2025 – Mar 2026 → "Last 4 months"
 * E.g., 12 monthly observations from Apr 2025 – Mar 2026 → "Last 12 months"
 */
function computeTimeRange(labels: string[]): string {
  if (labels.length < 2) return "Recent";
  const first = labels[0];
  const last = labels[labels.length - 1];

  const MONTH_MAP: Record<string, number> = {
    Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
    Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
  };

  // Parse YYYY-MM-DD, YYYY-MM, or "Mar 2026" dates
  const parseDate = (s: string): Date | null => {
    // ISO format: YYYY-MM-DD or YYYY-MM
    const isoMatch = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (isoMatch) {
      return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3] || "1"));
    }
    // BLS format: "Mar 2026" or "Jan 2025"
    const blsMatch = s.match(/^([A-Z][a-z]{2})\s+(\d{4})$/);
    if (blsMatch && MONTH_MAP[blsMatch[1]] !== undefined) {
      return new Date(parseInt(blsMatch[2]), MONTH_MAP[blsMatch[1]], 1);
    }
    return null;
  };

  const d1 = parseDate(first);
  const d2 = parseDate(last);
  if (!d1 || !d2) return "Recent";

  // Use month-based math for cleaner labels
  const diffMonths = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
  const diffDays = Math.abs(Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)));

  if (diffDays <= 14) return "Last 2 weeks";
  if (diffMonths <= 1) return "Last month";
  if (diffMonths <= 3) return "Last 3 months";
  if (diffMonths <= 6) return "Last 6 months";
  if (diffMonths <= 12) return "Last 12 months";
  if (diffMonths <= 24) return "Last 2 years";
  return "Historical";
}

/**
 * Generate an editorial chart caption from the data.
 * Bloomberg Markets style: what the chart shows + why the level matters.
 */
function generateChartCaption(
  title: string,
  values: number[],
  unit: string,
  timeRange: string
): string {
  if (values.length < 2) return "";

  const first = values[0];
  const last = values[values.length - 1];
  const change = last - first;
  const pctChange = first !== 0 ? ((change / Math.abs(first)) * 100) : 0;
  const direction = change > 0 ? "rose" : change < 0 ? "fell" : "held steady at";

  const formatVal = (v: number): string => {
    if (unit === "%") return `${v.toFixed(2)}%`;
    if (unit === "$/bbl") return `$${v.toFixed(2)}`;
    if (unit === "$B") return `$${v.toFixed(1)}B`;
    if (unit === "Points") return v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(0);
    return v.toFixed(2);
  };

  const absChange = Math.abs(pctChange);
  const changeMag = absChange >= 5 ? "sharply" : absChange >= 2 ? "notably" : "modestly";

  if (unit === "%") {
    return `${title} ${direction} ${changeMag} from ${formatVal(first)} to ${formatVal(last)} over the ${timeRange.replace("Last ", "past ").toLowerCase()}.`;
  }
  return `${title} ${direction} ${changeMag} to ${formatVal(last)} over the ${timeRange.replace("Last ", "past ").toLowerCase()}, a ${Math.abs(pctChange).toFixed(1)}% move.`;
}

/**
 * Fetch a chart-ready time series for a given topic key.
 * Returns { config, labels, values } or null if data unavailable.
 * Tries EIA first for energy topics, BLS for labor/inflation, FRED for macro.
 */
export async function fetchChartSeriesForTopic(
  topicKey: string,
  /** Optional ticker for stock-specific charts — used for ANY company-specific article */
  ticker?: string,
): Promise<(ChartSeriesConfig & { labels: string[]; values: number[] }) | null> {

  // ── Ticker-first: if a company ticker is identified, show its stock chart
  // regardless of topic category. A Novartis M&A story should show NVS, not
  // a generic 10Y Treasury. Macro-only topics (fed, inflation, GDP, employment,
  // bond_market) skip this since they have no company subject.
  const MACRO_ONLY_TOPICS = new Set([
    "federal_reserve", "fed_macro", "inflation", "gdp", "employment",
    "bond_market", "broad_market", "markets", "currency", "dxy",
  ]);

  if (ticker && process.env.FMP_API_KEY && !MACRO_ONLY_TOPICS.has(topicKey)) {
    const stockChart = await fetchFmpStockHistory(ticker, 90);
    if (stockChart) return stockChart;
    // If FMP fails, fall through to topic-based chart below
  }

  switch (topicKey) {

    case "federal_reserve":
    case "fed_macro": {
      // FEDFUNDS is a monthly series — 12 observations = 12 months (correct)
      const series = await fetchFredChartSeries("FEDFUNDS", 12);
      if (!series) return null;
      return { ...series, title: "Effective Federal Funds Rate", unit: "%", source: "FRED — St. Louis Fed", timeRange: computeTimeRange(series.labels), type: "line" };
    }

    case "bond_market": {
      // DGS10 is a daily series — fetch 90 observations (~4 months of trading days)
      const series = await fetchFredChartSeries("DGS10", 90);
      if (!series) return null;
      return { ...series, title: "10-Year Treasury Yield", unit: "%", source: "FRED — St. Louis Fed", timeRange: computeTimeRange(series.labels), type: "line" };
    }

    case "inflation": {
      // Fetch 2 years of BLS CPI data to compute YoY % change (much more readable than raw index)
      const blsSeries = await fetchBlsChartSeries(BLS_SERIES.CPI_ALL, 2);
      if (blsSeries) {
        const yoy = computeYoyChange(blsSeries.labels, blsSeries.values);
        if (yoy) {
          return {
            ...yoy,
            title: "CPI Inflation Rate (Year-over-Year)",
            unit: "%",
            source: "BLS — Bureau of Labor Statistics",
            timeRange: "Last 12 months",
            type: "line",
          };
        }
        // Not enough data for YoY — fall back to raw index with context
        return { ...blsSeries, title: "CPI — All Urban Consumers (Index)", unit: "Index", source: "BLS — Bureau of Labor Statistics", timeRange: "Last 2 years", type: "line" };
      }

      // BLS unavailable — try FRED CPIAUCSL as backup
      const fredSeries = await fetchFredChartSeries("CPIAUCSL", 24);
      if (fredSeries) {
        const yoy = computeYoyChange(fredSeries.labels, fredSeries.values);
        if (yoy) {
          return {
            ...yoy,
            title: "CPI Inflation Rate (Year-over-Year)",
            unit: "%",
            source: "FRED — St. Louis Fed",
            timeRange: "Last 12 months",
            type: "line",
          };
        }
      }
      return null;
    }

    case "employment": {
      const series = await fetchBlsChartSeries(BLS_SERIES.UNEMPLOYMENT, 2);
      if (series) return { ...series, title: "U.S. Unemployment Rate", unit: "%", source: "BLS — Bureau of Labor Statistics", timeRange: "Last 2 years", type: "line" };

      const fredSeries = await fetchFredChartSeries("UNRATE", 12);
      if (!fredSeries) return null;
      return { ...fredSeries, title: "U.S. Unemployment Rate", unit: "%", source: "FRED — St. Louis Fed", timeRange: "Last 12 months", type: "line" };
    }

    case "gdp": {
      const series = await fetchFredChartSeries("A191RL1Q225SBEA", 8);
      if (!series) return null;
      return { ...series, title: "Real GDP Growth Rate", unit: "%", source: "FRED — St. Louis Fed", timeRange: "Last 8 quarters", type: "bar" };
    }

    case "energy": {
      // Prefer EIA for energy charts (authoritative source)
      const series = await fetchWtiChartSeries(12);
      if (series) return { ...series, title: "WTI Crude Oil — Monthly Avg", unit: "$/bbl", source: "EIA — U.S. Energy Information Administration", timeRange: "Last 12 months", type: "line" };
      return null;
    }

    case "trade_policy": {
      // Brent crude for trade policy context (global benchmark)
      const series = await fetchEiaChartSeries(
        "petroleum/pri/spt",
        { series: ["RBRTE"] },
        "monthly",
        12
      );
      if (series) return { ...series, title: "Brent Crude — Monthly Avg", unit: "$/bbl", source: "EIA — U.S. Energy Information Administration", timeRange: "Last 12 months", type: "line" };
      return null;
    }

    case "earnings": {
      // If a specific ticker is provided, fetch its stock price chart from FMP
      if (ticker && process.env.FMP_API_KEY) {
        const stockChart = await fetchFmpStockHistory(ticker, 90);
        if (stockChart) return stockChart;
      }
      // Fallback: S&P 500 index context
      const series = await fetchFredChartSeries("SP500", 90);
      if (!series) return null;
      return { ...series, title: "S&P 500 Index — Earnings Context", unit: "Points", source: "FRED — St. Louis Fed", timeRange: computeTimeRange(series.labels), type: "line" };
    }

    case "broad_market":
    case "markets": {
      // S&P 500 index level — FRED daily series (SP500)
      // Fetch 90 observations (~4 months of trading days) for meaningful trend
      const series = await fetchFredChartSeries("SP500", 90);
      if (!series) return null;
      return { ...series, title: "S&P 500 Index", unit: "Points", source: "FRED — St. Louis Fed", timeRange: computeTimeRange(series.labels), type: "line" };
    }

    case "currency":
    case "dxy": {
      // FRED DTWEXBGS = Nominal Broad U.S. Dollar Index (trade-weighted, Jan 2006 = 100)
      // NOTE: This is NOT the ICE DXY (6-currency basket, ~97-110 range).
      // DTWEXBGS is a daily series — fetch 60 observations (~3 months of trading days)
      const series = await fetchFredChartSeries("DTWEXBGS", 60);
      if (!series) return null;
      return {
        ...series,
        title: "Nominal Broad U.S. Dollar Index",
        unit: "Index (Jan 2006=100)",
        source: "FRED — DTWEXBGS (Nominal Broad Dollar Index)",
        timeRange: computeTimeRange(series.labels),
        type: "line",
      };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Chart label + placement metadata per topic — institutional research style
// ---------------------------------------------------------------------------

const CHART_METADATA: Record<string, { chartLabel: string; insertAfterParagraph: number }> = {
  energy:          { chartLabel: "ENERGY MARKETS",  insertAfterParagraph: 0 },
  trade_policy:    { chartLabel: "ENERGY MARKETS",  insertAfterParagraph: 0 },
  federal_reserve: { chartLabel: "MONETARY POLICY", insertAfterParagraph: 1 },
  fed_macro:       { chartLabel: "MONETARY POLICY", insertAfterParagraph: 1 },
  bond_market:     { chartLabel: "RATES",            insertAfterParagraph: 1 },
  inflation:       { chartLabel: "INFLATION",        insertAfterParagraph: 1 },
  employment:      { chartLabel: "LABOR MARKET",     insertAfterParagraph: 1 },
  gdp:             { chartLabel: "GROWTH",           insertAfterParagraph: 1 },
  earnings:        { chartLabel: "STOCK",              insertAfterParagraph: 1 },
  broad_market:    { chartLabel: "MARKET CONTEXT",   insertAfterParagraph: 1 },
  markets:         { chartLabel: "MARKET CONTEXT",   insertAfterParagraph: 1 },
  currency:        { chartLabel: "DOLLAR INDEX",     insertAfterParagraph: 2 },
  dxy:             { chartLabel: "DOLLAR INDEX",     insertAfterParagraph: 2 },
};

/**
 * Build a complete ChartDataset for use in NewsItem.chartData.
 * Attaches: editorial reference lines, chartLabel, insertAfterParagraph, and
 * appends the timeframe to the chart title for institutional clarity.
 * Returns undefined if no API key is set or the topic has no chart mapping.
 */
export async function buildNewsChartData(
  topicKey: string,
  /** Optional ticker for stock-specific earnings charts */
  ticker?: string,
): Promise<ChartDataset | undefined> {
  try {
    const result = await fetchChartSeriesForTopic(topicKey, ticker);
    if (!result || result.values.length < 3) return undefined;

    // If the chart is a stock price chart (from FMP), use "STOCK" label
    // regardless of the topic's default chart metadata
    const isStockChart = result.source?.includes("FMP") && result.unit === "$";
    const meta = isStockChart
      ? { chartLabel: "STOCK", insertAfterParagraph: 1 }
      : CHART_METADATA[topicKey];

    // Append timeframe to title if not already present (e.g., "(12-Month)")
    let title = result.title;
    if (result.timeRange && !title.includes("(")) {
      const mMonth = result.timeRange.match(/last\s+(\d+)\s+month/i);
      const mQuarter = result.timeRange.match(/last\s+(\d+)\s+quarter/i);
      const mWeek = result.timeRange.match(/last\s+(\d+)\s+week/i);
      const mYear = result.timeRange.match(/last\s+(\d+)\s+year/i);
      const mSingularMonth = result.timeRange.match(/^last\s+month$/i);
      if (mMonth) title = `${title} (${mMonth[1]}-Month)`;
      else if (mQuarter) title = `${title} (${mQuarter[1]}-Quarter)`;
      else if (mWeek) title = `${title} (${mWeek[1]}-Week)`;
      else if (mYear) title = `${title} (${mYear[1]}-Year)`;
      else if (mSingularMonth) title = `${title} (1-Month)`;
    }

    // Generate editorial caption from actual data
    const caption = generateChartCaption(result.title, result.values, result.unit, result.timeRange);

    // ── Time-series validation ─────────────────────────────────────────────
    // 1. Deduplicate labels — keep the last value for duplicate timestamps
    // 2. Ensure chronological order — sort by label when date-parseable
    const deduped = new Map<string, number>();
    for (let i = 0; i < result.labels.length; i++) {
      deduped.set(result.labels[i], result.values[i]);
    }
    let validatedLabels = Array.from(deduped.keys());
    let validatedValues = Array.from(deduped.values());

    // Sort chronologically if labels are date-like (YYYY-MM-DD or YYYY-MM)
    if (validatedLabels.length > 0 && /^\d{4}-\d{2}/.test(validatedLabels[0])) {
      const pairs = validatedLabels.map((l, i) => ({ label: l, value: validatedValues[i] }));
      pairs.sort((a, b) => a.label.localeCompare(b.label));
      validatedLabels = pairs.map((p) => p.label);
      validatedValues = pairs.map((p) => p.value);
    }

    if (validatedLabels.length !== result.labels.length) {
      console.warn(`[chart] ${topicKey}: deduplicated ${result.labels.length} → ${validatedLabels.length} points`);
    }

    const dataset: ChartDataset = {
      title,
      type: result.type,
      labels: validatedLabels,
      values: validatedValues,
      unit: result.unit,
      source: result.source,
      timeRange: result.timeRange,
      chartLabel: meta?.chartLabel,
      insertAfterParagraph: meta?.insertAfterParagraph,
      caption: caption || undefined,
    };

    // Attach well-known benchmark reference lines for editorial context
    if (topicKey === "inflation") {
      dataset.referenceValue = 2.0;
      dataset.referenceLabel = "Fed 2% Target";
    }

    return dataset;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// SECTION 9 — Briefing helpers (What to Watch)
// ---------------------------------------------------------------------------

// Macro event significance library — maps common event keywords to analytical descriptions
const MACRO_SIGNIFICANCE: Record<string, string> = {
  "fomc": "Fed rate decisions directly reprice the entire yield curve; any surprise shifts forward guidance for rate-sensitive sectors and the dollar.",
  "federal reserve": "Fed commentary shifts rate expectations and reprices bonds, equities, and the dollar simultaneously.",
  "fed": "Fed rate decisions directly reprice the entire yield curve; any surprise shifts forward guidance for rate-sensitive sectors and the dollar.",
  "cpi": "CPI beats relative to consensus force the market to re-price near-term Fed cuts, pressuring rate-sensitive equities and lifting real yields.",
  "consumer price": "CPI beats relative to consensus force the market to re-price near-term Fed cuts, pressuring rate-sensitive equities and lifting real yields.",
  "pce": "The Fed's preferred inflation gauge; a hot print reduces the pace of rate cuts and lifts real yields, pressuring equity multiples.",
  "non-farm payroll": "A strong payroll print delays Fed cuts by reducing urgency for easing, lifting the dollar and compressing equity P/E multiples.",
  "nonfarm payroll": "A strong payroll print delays Fed cuts by reducing urgency for easing, lifting the dollar and compressing equity P/E multiples.",
  "jobs report": "Labor market strength or weakness directly shapes Fed policy expectations and thus the discount rate applied to all asset classes.",
  "unemployment": "Unemployment data informs Fed slack estimates; a tighter labor market keeps inflation pressure alive, extending the higher-for-longer rate narrative.",
  "gdp": "GDP surprises shift growth expectations and recalibrate Fed trajectory — a miss raises recession risk and pressures cyclical earnings.",
  "ism manufacturing": "Manufacturing PMI below 50 signals contraction in goods-producing sectors and tends to pull Treasury yields and commodity prices lower.",
  "ism services": "Services PMI captures the dominant sector of the U.S. economy; a miss raises recession risk given services account for ~70% of GDP.",
  "pmi": "PMI data signals whether economic momentum is expanding or contracting, shaping earnings revision cycles for cyclical sectors.",
  "retail sales": "Retail sales measure consumer spending, the largest GDP component; a miss raises stagflation risk if inflation remains elevated.",
  "ppi": "PPI measures upstream price pressure that feeds into CPI with a lag — a hot print warns of future consumer inflation.",
  "housing": "Housing data reflects the transmission of monetary policy; sustained weakness signals rate-sensitive sectors remain under pressure.",
  "durable goods": "Durable goods orders track business investment intentions; weakness signals corporate caution about future demand.",
  "trade balance": "Trade deficits widen or narrow based on dollar strength and domestic demand, directly affecting GDP calculations.",
  "treasury": "Treasury auctions test demand for U.S. debt; weak demand pushes yields higher, pressuring equity multiples.",
  "debt ceiling": "Debt ceiling uncertainty raises default risk premia across all U.S.-denominated assets and increases volatility.",
  "tariff": "Tariff changes directly alter import costs, corporate margins, and trade flows — a shock to both inflation and growth simultaneously.",
};

function getMacroSignificance(eventName: string, estimate?: number | null, previous?: number | null): string {
  const lower = eventName.toLowerCase();
  for (const [key, sig] of Object.entries(MACRO_SIGNIFICANCE)) {
    if (lower.includes(key)) return sig;
  }
  // Generic fallback with estimate/previous context if available
  const context = estimate != null && previous != null
    ? ` Consensus estimate: ${estimate}; prior: ${previous}.`
    : "";
  return `A high-impact economic release that can reprice rate expectations and move equity risk premiums.${context}`;
}

/**
 * Build a "What to Watch" list for the Daily Briefing.
 * Priority: (1) upcoming U.S. high-impact macro releases from FMP economic calendar,
 * (2) notable earnings as secondary fill only.
 * Returns up to 3 events.
 */
export async function fetchBriefingWhatToWatch(): Promise<Array<{
  event: string;
  timing: string;
  significance: string;
  watchMetric?: string;
}>> {
  const events: Array<{ event: string; timing: string; significance: string; watchMetric?: string }> = [];

  // 1. FMP economic calendar — macro events are ABSOLUTE first priority
  try {
    if (process.env.FMP_API_KEY) {
      const from = new Date().toISOString().split("T")[0];
      const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const res = await fetch(
        fmpUrl("/api/v3/economic_calendar", { from, to, country: "US" }),
        { signal: withTimeout() }
      );
      if (res.ok) {
        const data: Array<{
          event: string;
          date: string;
          country: string;
          impact: string;
          estimate?: number;
          previous?: number;
        }> = await res.json();

        // U.S. high-impact events only, deduplicated by event name, sorted by date
        const seen = new Set<string>();
        const highImpact = (Array.isArray(data) ? data : [])
          .filter((e) => e.country === "US" && e.impact === "High" && !seen.has(e.event) && seen.add(e.event))
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(0, 3);

        for (const e of highImpact) {
          const estimateCtx = e.estimate != null && e.previous != null
            ? ` Consensus: ${e.estimate}; prior: ${e.previous}.`
            : e.previous != null
            ? ` Prior: ${e.previous}.`
            : "";

          events.push({
            event: e.event,
            timing: `Upcoming economic data — ${e.date}`,
            significance: getMacroSignificance(e.event, e.estimate, e.previous) + estimateCtx,
            watchMetric: getWatchMetric(e.event),
          });
        }
      }
    }
  } catch {
    // Non-fatal — fall through to earnings
  }

  // 2. Fill remaining slots with major earnings (secondary priority)
  if (events.length < 2) {
    try {
      const earnings = await fetchFmpEarningsCalendar(7);
      const notable = earnings
        .filter((e) => e.revenueEstimated && e.revenueEstimated > 5_000_000_000)
        .slice(0, 2 - events.length);

      for (const e of notable) {
        const when = e.time === "bmo" ? "Before market open" : e.time === "amc" ? "After market close" : "";
        events.push({
          event: `${e.symbol} earnings`,
          timing: `${e.date}${when ? ` — ${when}` : ""}`,
          significance: `Consensus EPS estimate${e.epsEstimated ? ` $${e.epsEstimated.toFixed(2)}` : " pending"}; results could drive sector-wide moves.`,
        });
      }
    } catch {
      // Non-fatal
    }
  }

  // 3. Fallback if still nothing
  if (events.length === 0) {
    events.push({
      event: "Next FOMC meeting",
      timing: "Policy watch",
      significance: "Rate decisions drive bond yields and rate-sensitive equity sectors.",
      watchMetric: "Fed Funds futures pricing for next meeting",
    });
  }

  return events;
}

/**
 * Returns a suggested watchMetric for common macro events.
 * These are the specific price levels / thresholds investors monitor
 * around each data release.
 */
function getWatchMetric(eventName: string): string | undefined {
  const lower = eventName.toLowerCase();
  if (lower.includes("fomc") || lower.includes("federal reserve") || lower.includes("fed"))
    return "Fed Funds futures pricing; 2-Year Treasury yield direction";
  if (lower.includes("cpi") || lower.includes("consumer price"))
    return "Core CPI vs. 0.3% MoM consensus; 10-Year breakeven inflation rate";
  if (lower.includes("pce"))
    return "Core PCE vs. Fed's 2% target; 10-Year Treasury yield reaction";
  if (lower.includes("non-farm") || lower.includes("nonfarm") || lower.includes("payroll"))
    return "NFP vs. consensus; unemployment rate; average hourly earnings";
  if (lower.includes("gdp"))
    return "GDP growth rate vs. consensus; GDPNow tracker comparison";
  if (lower.includes("ism") || lower.includes("pmi"))
    return "ISM/PMI above or below 50 expansion threshold";
  if (lower.includes("retail sales"))
    return "Retail sales MoM change; control group ex-autos";
  if (lower.includes("ppi"))
    return "PPI vs. consensus; pass-through implications for CPI";
  if (lower.includes("housing") || lower.includes("home"))
    return "Housing starts/permits vs. consensus; 30-year mortgage rate";
  if (lower.includes("jobless") || lower.includes("claims"))
    return "Initial claims vs. 4-week moving average; continuing claims trend";
  return undefined;
}
