import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection, NewsItem, ChartDataset, KeyDataPoint } from "@/lib/news-types";
import {
  fetchFmpStockHistory,
  fetchFmpCompanyProfile,
  buildComparisonChart,
} from "@/lib/market-data";

export const maxDuration = 60;
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Company ticker inference — maps company names to tickers
// ---------------------------------------------------------------------------
const COMPANY_TICKERS: [RegExp, string][] = [
  [/\blululemon\b/i, "LULU"],
  [/\bnike\b/i, "NKE"],
  [/\bapple\b/i, "AAPL"],
  [/\btesla\b/i, "TSLA"],
  [/\bnvidia\b|\bNVDA\b|\bblackwell\b|\bjensen huang\b/i, "NVDA"],
  [/\bmeta\b.*\bplatform/i, "META"],
  [/\bgoogle\b|\balphabet\b/i, "GOOGL"],
  [/\bamazon\b/i, "AMZN"],
  [/\bmicrosoft\b/i, "MSFT"],
  [/\bhumana\b/i, "HUM"],
  [/\bfirst solar\b/i, "FSLR"],
  [/\bnextracker\b/i, "NXT"],
  [/\bsprouts\b/i, "SFM"],
  [/\bboeing\b/i, "BA"],
  [/\bjpmorgan\b/i, "JPM"],
  [/\bgoldman sachs\b/i, "GS"],
  [/\bnovartis\b/i, "NVS"],
  [/\bavidity\b/i, "AVID"],
  [/\bibm\b/i, "IBM"],
  [/\bbentley\b/i, "BNTGY"],
  [/\bvolkswagen\b|\bvwagy\b|\bvw\b/i, "VWAGY"],
  [/\bon holding\b/i, "ONON"],
  [/\bdelta air\b/i, "DAL"],
  [/\bunited airlines\b/i, "UAL"],
  [/\bcoinbase\b/i, "COIN"],
  [/\bpalantir\b/i, "PLTR"],
  [/\bjio\b.*\bipo\b|\breliance\b/i, "INDA"],
];

function inferTicker(title: string, story: string): string | null {
  const text = `${title} ${story}`.toLowerCase();
  for (const [regex, ticker] of COMPANY_TICKERS) {
    if (regex.test(text)) return ticker;
  }
  return null;
}

// Macro topics should keep their existing charts (they're already relevant)
const MACRO_TOPICS = new Set([
  "federal_reserve", "fed_macro", "inflation", "gdp", "employment",
  "bond_market", "broad_market", "markets", "currency", "dxy",
]);

// Sentiment corrections based on article content
const SENTIMENT_OVERRIDES: Record<string, "positive" | "negative" | "neutral"> = {
  "news-1773770975678-1930": "neutral",   // Apple/IBM M&A — strategic, not negative
};

// Category/topicKey corrections
const CATEGORY_OVERRIDES: Record<string, { category: "macro" | "earnings" | "markets" | "policy" | "crypto" | "other"; topicKey: string }> = {
  "news-1773770994516-1378": { category: "markets", topicKey: "layoffs" }, // Bentley
};

// ---------------------------------------------------------------------------
// POST /api/admin/enrich-articles
//
// Retroactive enrichment: replace generic charts with company-specific ones,
// add missing key data points from FMP, and fix metadata issues.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  try {
    const collection = await kv.get<NewsCollection>("news");
    if (!collection || !collection.news || collection.news.length === 0) {
      return NextResponse.json({ message: "No articles to enrich", enriched: 0 });
    }

    const enrichLog: Array<{ id: string; title: string; changes: string[] }> = [];

    for (const article of collection.news) {
      const changes: string[] = [];
      const ticker = inferTicker(article.title, article.story);

      // Skip macro-only topics — their charts are already relevant
      const isMacro = MACRO_TOPICS.has(article.topicKey ?? "");

      // ── 1. Replace generic 10Y Treasury charts with stock-specific ones ──
      if (ticker && !isMacro && article.chartData && article.chartData.length > 0) {
        const hasGenericChart = article.chartData.some(
          (c) => c.title.includes("Treasury") || c.title.includes("S&P 500")
        );

        if (hasGenericChart) {
          console.log(`[enrich] Fetching stock data for ${ticker} (FMP_API_KEY set: ${!!process.env.FMP_API_KEY})`);

          // Fetch stock chart + comparison chart
          const [stockChart, comparisonChart] = await Promise.allSettled([
            fetchFmpStockHistory(ticker, 90),
            buildComparisonChart(ticker, 90),
          ]);

          console.log(`[enrich] ${ticker} results: stock=${stockChart.status}${stockChart.status === 'rejected' ? ' err=' + String(stockChart.reason) : stockChart.value ? ' pts=' + stockChart.value.values.length : ' null'}, comparison=${comparisonChart.status}${comparisonChart.status === 'rejected' ? ' err=' + String(comparisonChart.reason) : comparisonChart.value ? ' series' : ' null'}`);

          const newCharts: ChartDataset[] = [];

          if (stockChart.status === "fulfilled" && stockChart.value) {
            const sc = stockChart.value;
            newCharts.push({
              title: `${sc.title} (${sc.timeRange ?? "90-Day"})`,
              type: "line",
              labels: sc.labels,
              values: sc.values,
              unit: "$",
              source: sc.source,
              timeRange: sc.timeRange,
              chartLabel: "STOCK",
              insertAfterParagraph: 1,
              caption: `${ticker} stock price over the past ${sc.timeRange?.toLowerCase().replace("last ", "") ?? "90 days"}.`,
            });
            changes.push(`chart: replaced generic Treasury with ${ticker} stock price`);
          }

          if (comparisonChart.status === "fulfilled" && comparisonChart.value) {
            const cc = comparisonChart.value;
            cc.insertAfterParagraph = 3;
            newCharts.push(cc);
            changes.push(`chart: added ${ticker} vs S&P 500 comparison`);
          }

          // Keep any non-generic charts (e.g., CPI for stagflation)
          const keptCharts = article.chartData.filter(
            (c) => !c.title.includes("Treasury") && !c.title.includes("S&P 500")
          );

          if (newCharts.length > 0) {
            article.chartData = [...newCharts, ...keptCharts].slice(0, 3);
          }
        }
      }

      // ── 2. Add missing company key data points from FMP ──
      if (ticker && !isMacro) {
        const hasCompanyData = (article.keyDataPoints ?? []).some(
          (dp) => dp.label.includes(ticker) || dp.label.includes("Market Cap") || dp.label.includes("P/E")
        );

        if (!hasCompanyData) {
          try {
            const profile = await fetchFmpCompanyProfile(ticker);
            if (profile) {
              const newPoints: KeyDataPoint[] = [];

              if (profile.mktCap) {
                const capB = (profile.mktCap / 1e9).toFixed(1);
                newPoints.push({ label: `${ticker} Market Cap`, value: `$${capB}B`, source: "FMP" });
              }
              if (profile.price) {
                const changeStr = profile.changes != null
                  ? ` (${profile.changes >= 0 ? "+" : ""}${profile.changes.toFixed(2)}%)`
                  : "";
                newPoints.push({ label: `${ticker} Price`, value: `$${profile.price.toFixed(2)}${changeStr}`, source: "FMP" });
              }
              if (profile.pe && profile.pe > 0) {
                newPoints.push({ label: `${ticker} P/E`, value: profile.pe.toFixed(1), source: "FMP" });
              }
              if (profile.sector) {
                newPoints.push({ label: "Sector", value: profile.sector, source: "FMP" });
              }

              if (newPoints.length > 0) {
                // Prepend company data before generic macro data
                article.keyDataPoints = [...newPoints, ...(article.keyDataPoints ?? [])];
                changes.push(`keyData: added ${newPoints.length} ${ticker} data points (market cap, price, P/E, sector)`);
              }
            }
          } catch {
            // Non-blocking
          }
        }
      }

      // ── 3. Fix sentiment overrides ──
      const sentimentFix = SENTIMENT_OVERRIDES[article.id];
      if (sentimentFix && article.sentiment !== sentimentFix) {
        changes.push(`sentiment: ${article.sentiment}→${sentimentFix}`);
        article.sentiment = sentimentFix;
      }

      // ── 4. Fix category/topicKey overrides ──
      const catFix = CATEGORY_OVERRIDES[article.id];
      if (catFix) {
        if (article.category !== catFix.category) {
          changes.push(`category: ${article.category}→${catFix.category}`);
          article.category = catFix.category;
        }
        if (article.topicKey !== catFix.topicKey) {
          changes.push(`topicKey: ${article.topicKey}→${catFix.topicKey}`);
          article.topicKey = catFix.topicKey;
        }
      }

      // ── 5. Fix un-normalized topicKeys ──
      if (article.topicKey && article.topicKey.includes(" ")) {
        const old = article.topicKey;
        article.topicKey = article.topicKey.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
        changes.push(`topicKey: "${old}"→"${article.topicKey}" (normalized)`);
      }

      if (changes.length > 0) {
        enrichLog.push({ id: article.id, title: article.title, changes });
      }
    }

    // Save back to KV
    if (enrichLog.length > 0) {
      collection.lastUpdated = new Date().toISOString();
      await kv.set("news", collection);
    }

    // Diagnostic: return skipped article reasons
    const diagnostics: Array<{ id: string; title: string; ticker: string | null; isMacro: boolean; hasGenericChart: boolean; fmpKey: boolean }> = [];
    for (const article of collection.news) {
      const t = inferTicker(article.title, article.story);
      const im = MACRO_TOPICS.has(article.topicKey ?? "");
      const gc = (article.chartData ?? []).some(
        (c: ChartDataset) => c.title.includes("Treasury") || c.title.includes("S&P 500")
      );
      diagnostics.push({
        id: article.id.slice(0, 20),
        title: article.title.slice(0, 40),
        ticker: t,
        isMacro: im,
        hasGenericChart: gc,
        fmpKey: !!process.env.FMP_API_KEY,
      });
    }

    return NextResponse.json({
      message: `Enriched ${enrichLog.length} of ${collection.news.length} articles`,
      enriched: enrichLog.length,
      details: enrichLog,
      diagnostics,
    });
  } catch (error) {
    console.error("[enrich-articles] Error:", error);
    return NextResponse.json(
      { error: "Enrichment failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
