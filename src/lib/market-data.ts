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
  topicKey: string
): Promise<KeyDataPoint[]> {
  const points: KeyDataPoint[] = [];

  try {
    switch (topicKey) {

      // ── Federal Reserve / monetary policy ──────────────────────────────
      case "federal_reserve":
      case "fed_macro": {
        const [fedfunds, treasury10y, treasury2y, blsMacro] = await Promise.allSettled([
          fetchFredLatest("FEDFUNDS"),
          fetchFredLatest("DGS10"),
          fetchFredLatest("DGS2"),
          fetchBlsMacroSummary(),
        ]);

        if (fedfunds.status === "fulfilled" && fedfunds.value)
          points.push({ label: "Fed Funds Rate", value: `${fedfunds.value.value}%`, source: "FRED" });
        if (treasury10y.status === "fulfilled" && treasury10y.value)
          points.push({ label: "10-Year Treasury", value: `${treasury10y.value.value}%`, source: "FRED" });
        if (treasury2y.status === "fulfilled" && treasury2y.value)
          points.push({ label: "2-Year Treasury", value: `${treasury2y.value.value}%`, source: "FRED" });
        if (blsMacro.status === "fulfilled" && blsMacro.value.cpi)
          points.push({ label: "CPI (BLS)", value: blsMacro.value.cpi.value, source: "BLS" });
        break;
      }

      // ── Inflation ───────────────────────────────────────────────────────
      case "inflation": {
        const seriesIds = [BLS_SERIES.CPI_ALL, BLS_SERIES.CPI_CORE, BLS_SERIES.PPI_FINISHED];
        const [blsResult, fredCpi] = await Promise.allSettled([
          fetchBlsMultipleSeries(seriesIds, 1),
          fetchFredLatest("CPIAUCSL"),
        ]);

        if (blsResult.status === "fulfilled") {
          const bls = blsResult.value;
          if (bls[BLS_SERIES.CPI_ALL]?.[0])
            points.push({ label: "CPI All Items", value: bls[BLS_SERIES.CPI_ALL][0].value, source: "BLS" });
          if (bls[BLS_SERIES.CPI_CORE]?.[0])
            points.push({ label: "Core CPI", value: bls[BLS_SERIES.CPI_CORE][0].value, source: "BLS" });
          if (bls[BLS_SERIES.PPI_FINISHED]?.[0])
            points.push({ label: "PPI Finished Goods", value: bls[BLS_SERIES.PPI_FINISHED][0].value, source: "BLS" });
        }
        if (fredCpi.status === "fulfilled" && fredCpi.value && points.length === 0)
          points.push({ label: "CPI Index (FRED)", value: fredCpi.value.value, source: "FRED" });
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
          fetchFredLatest("DGS10"),
          fetchFredLatest("DGS2"),
          fetchFredLatest("DGS30"),
          fetchFredLatest("FEDFUNDS"),
        ]);

        if (t10y.status === "fulfilled" && t10y.value)
          points.push({ label: "10-Year Yield", value: `${t10y.value.value}%`, source: "FRED" });
        if (t2y.status === "fulfilled" && t2y.value)
          points.push({ label: "2-Year Yield", value: `${t2y.value.value}%`, source: "FRED" });
        if (t30y.status === "fulfilled" && t30y.value)
          points.push({ label: "30-Year Yield", value: `${t30y.value.value}%`, source: "FRED" });
        if (fedfunds.status === "fulfilled" && fedfunds.value)
          points.push({ label: "Fed Funds Rate", value: `${fedfunds.value.value}%`, source: "FRED" });
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
          fetchFredLatest("DGS10"),
        ]);
        if (energy.status === "fulfilled") {
          if (energy.value.wti)
            points.push({ label: "WTI Crude", value: `$${energy.value.wti.value.toFixed(2)}/bbl`, source: "EIA" });
          if (energy.value.brent)
            points.push({ label: "Brent Crude", value: `$${energy.value.brent.value.toFixed(2)}/bbl`, source: "EIA" });
        }
        if (treasury10y.status === "fulfilled" && treasury10y.value)
          points.push({ label: "10-Year Treasury", value: `${treasury10y.value.value}%`, source: "FRED" });
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
        const t10y = await fetchFredLatest("DGS10");
        if (t10y)
          points.push({ label: "10-Year Treasury", value: `${t10y.value}%`, source: "FRED" });
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
          fetchFredLatest("DGS10"),
          fetchStockQuote("SPY"),
        ]);
        if (t10y.status === "fulfilled" && t10y.value)
          points.push({ label: "10-Year Yield", value: `${t10y.value.value}%`, source: "FRED" });
        if (spy.status === "fulfilled" && spy.value)
          points.push({ label: "S&P 500 ETF (SPY)", value: spy.value.price, change: spy.value.changePercent, source: "Alpha Vantage" });
        break;
      }

      // ── Default: macro summary ─────────────────────────────────────────
      default: {
        const [fedfunds, t10y] = await Promise.allSettled([
          fetchFredLatest("FEDFUNDS"),
          fetchFredLatest("DGS10"),
        ]);
        if (fedfunds.status === "fulfilled" && fedfunds.value)
          points.push({ label: "Fed Funds Rate", value: `${fedfunds.value.value}%`, source: "FRED" });
        if (t10y.status === "fulfilled" && t10y.value)
          points.push({ label: "10-Year Treasury", value: `${t10y.value.value}%`, source: "FRED" });
        break;
      }
    }
  } catch (err) {
    // Never let market data failures break the synthesis pipeline
    logWarn("contextual", `fetchContextualData failed for ${topicKey}: ${String(err)}`);
  }

  return points.slice(0, 5); // Cap at 5 data points per story
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
  topicKey: string
): Promise<(ChartSeriesConfig & { labels: string[]; values: number[] }) | null> {

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
  topicKey: string
): Promise<ChartDataset | undefined> {
  try {
    const result = await fetchChartSeriesForTopic(topicKey);
    if (!result || result.values.length < 3) return undefined;

    const meta = CHART_METADATA[topicKey];

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

    const dataset: ChartDataset = {
      title,
      type: result.type,
      labels: result.labels,
      values: result.values,
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

/**
 * Build a "What to Watch" list for the Daily Briefing from FMP earnings calendar.
 * Returns up to 3 notable upcoming events.
 */
export async function fetchBriefingWhatToWatch(): Promise<Array<{
  event: string;
  timing: string;
  significance: string;
}>> {
  const events: Array<{ event: string; timing: string; significance: string }> = [];

  try {
    // Upcoming high-profile earnings
    const earnings = await fetchFmpEarningsCalendar(7);
    const notable = earnings
      .filter((e) => e.revenueEstimated && e.revenueEstimated > 5_000_000_000) // >$5B companies
      .slice(0, 2);

    for (const e of notable) {
      const when = e.time === "bmo" ? "Before market open" : e.time === "amc" ? "After market close" : "";
      events.push({
        event: `${e.symbol} earnings`,
        timing: `${e.date}${when ? ` — ${when}` : ""}`,
        significance: `Consensus EPS estimate${e.epsEstimated ? ` $${e.epsEstimated.toFixed(2)}` : " pending"}; results could drive sector-wide moves.`,
      });
    }
  } catch {
    // Non-fatal — briefing works without this
  }

  // Fallback event if nothing from FMP
  if (events.length === 0) {
    events.push({
      event: "Next FOMC meeting",
      timing: "Upcoming",
      significance: "Rate decisions drive bond yields and rate-sensitive equity sectors.",
    });
  }

  return events;
}
