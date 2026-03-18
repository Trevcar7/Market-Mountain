import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection, NewsItem } from "@/lib/news-types";

export const maxDuration = 30;
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Thresholds — aligned with editorial-qa.ts and news-synthesis.ts
// ---------------------------------------------------------------------------
const FACT_CHECK_FLOOR = 90;
const CONFIDENCE_FLOOR = 0.85;
const MAX_IMPORTANCE = 10;
const STALE_HOURS = 72;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AutoFix {
  articleId: string;
  title: string;
  fixes: string[];
}

interface Recommendation {
  articleId: string;
  title: string;
  severity: "critical" | "warning" | "info";
  issue: string;
  recommendation: string;
}

interface SweepReport {
  timestamp: string;
  articlesChecked: number;
  autoFixes: AutoFix[];
  recommendations: Recommendation[];
  health: {
    overallGrade: string;
    factCheckAvg: number;
    confidenceAvg: number;
    brokenImages: number;
    staleArticles: number;
    hallucinations: number;
  };
}

// ---------------------------------------------------------------------------
// POST /api/admin/quality-sweep
//
// Comprehensive quality audit of all live news articles. Two tiers:
//   Tier 1 — Auto-fix: importance cap, hallucination scrub, ticker
//            normalization, category corrections, market impact cleanup
//   Tier 2 — Recommendations: low fact-check scores, missing charts,
//            stale articles, broken images, missing primary tickers
//
// Returns a SweepReport JSON. Also saves the report to KV for dashboard use.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const validSecret = process.env.CRON_SECRET || process.env.FETCH_NEWS_SECRET;
  if (validSecret && authHeader !== `Bearer ${validSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  try {
    const collection = await kv.get<NewsCollection>("news");
    if (!collection || !collection.news || collection.news.length === 0) {
      return NextResponse.json({ message: "No articles to sweep", articlesChecked: 0 });
    }

    const autoFixes: AutoFix[] = [];
    const recommendations: Recommendation[] = [];
    let mutated = false;
    let totalFactCheck = 0;
    let totalConfidence = 0;
    let brokenImages = 0;
    let staleCount = 0;
    let hallucinationCount = 0;

    const now = Date.now();

    for (const article of collection.news) {
      const fixes: string[] = [];

      // ──────────────────────────────────────────────────────────────────────
      // TIER 1: AUTO-FIXES
      // ──────────────────────────────────────────────────────────────────────

      // 1. Cap importance at MAX_IMPORTANCE
      if (article.importance > MAX_IMPORTANCE) {
        fixes.push(`importance: ${article.importance}→${MAX_IMPORTANCE}`);
        article.importance = MAX_IMPORTANCE;
      }

      // 2. Scrub hallucinated sentences from story body
      if (article.hallucinations && article.hallucinations.length > 0 && article.story) {
        const before = article.story.length;
        article.story = scrubHallucinations(article.story, article.hallucinations);
        if (article.story.length < before) {
          fixes.push(`story: scrubbed ${article.hallucinations.length} hallucinated sentence(s)`);
          hallucinationCount += article.hallucinations.length;
        }
        article.hallucinations = [];
      }

      // 3. Normalize generic ticker tags
      const GENERIC_TAG_MAP: Record<string, string> = {
        RATES: "TLT", MACRO: "SPY", EQUITIES: "SPY",
        BONDS: "TLT", "FIXED INCOME": "TLT",
        OIL: "WTI", DOLLAR: "DXY",
      };
      if (article.relatedTickers) {
        const oldTickers = [...article.relatedTickers];
        article.relatedTickers = article.relatedTickers.map((t) => GENERIC_TAG_MAP[t.toUpperCase()] ?? t);
        article.relatedTickers = [...new Set(article.relatedTickers)];
        if (JSON.stringify(oldTickers) !== JSON.stringify(article.relatedTickers)) {
          fixes.push(`tickers: normalized [${oldTickers}]→[${article.relatedTickers}]`);
        }
      }

      // 4. Remove malformed market impact entries
      if (article.marketImpact && article.marketImpact.length > 0) {
        const VALID = /^[+\-]\d+[.,]?\d*\s*(%|bps|bp)$/i;
        const cleaned = article.marketImpact.filter((mi) => VALID.test(mi.change.trim()));
        if (cleaned.length < article.marketImpact.length) {
          const removed = article.marketImpact.length - cleaned.length;
          fixes.push(`marketImpact: removed ${removed} malformed entries`);
          article.marketImpact = cleaned.length > 0 ? cleaned : undefined;
        }
      }

      // 5. Strip hashtags from story fields
      const HAS_HASHTAG = /(?<!\w)#[A-Za-z]/;
      const stripHashtags = (s: string) => s.replace(/(?<!\w)#([A-Za-z]\w*)/g, "$1");
      if (article.story && HAS_HASHTAG.test(article.story)) {
        article.story = stripHashtags(article.story);
        fixes.push("story: stripped hashtags");
      }

      if (fixes.length > 0) {
        autoFixes.push({ articleId: article.id, title: article.title, fixes });
        mutated = true;
      }

      // ──────────────────────────────────────────────────────────────────────
      // TIER 2: RECOMMENDATIONS (human review)
      // ──────────────────────────────────────────────────────────────────────

      // 6. Low fact-check score
      const fcs = article.factCheckScore ?? 0;
      totalFactCheck += fcs;
      if (fcs < FACT_CHECK_FLOOR) {
        recommendations.push({
          articleId: article.id,
          title: article.title,
          severity: fcs < 50 ? "critical" : "warning",
          issue: `Fact-check score ${fcs}/${FACT_CHECK_FLOOR}`,
          recommendation: "Re-synthesize or manually verify key claims. Current score below publication threshold.",
        });
      }

      // 7. Low confidence score
      const conf = article.confidenceScore ?? 0;
      totalConfidence += conf;
      if (conf < CONFIDENCE_FLOOR) {
        recommendations.push({
          articleId: article.id,
          title: article.title,
          severity: conf < 0.6 ? "critical" : "warning",
          issue: `Confidence score ${(conf * 100).toFixed(0)}%/${(CONFIDENCE_FLOOR * 100).toFixed(0)}%`,
          recommendation: "Article may lack multi-source corroboration. Consider adding sources or re-synthesizing.",
        });
      }

      // 8. Missing primary subject ticker
      if (article.relatedTickers && article.story) {
        const primaryTicker = inferPrimaryTicker(article.title, article.story);
        if (primaryTicker && !article.relatedTickers.includes(primaryTicker)) {
          recommendations.push({
            articleId: article.id,
            title: article.title,
            severity: "warning",
            issue: `Primary subject ticker "${primaryTicker}" missing from relatedTickers [${article.relatedTickers.join(",")}]`,
            recommendation: `Add "${primaryTicker}" to relatedTickers — it appears to be the main subject of this article.`,
          });
        }
      }

      // 9. Article staleness (>STALE_HOURS old)
      const ageHours = (now - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60);
      if (ageHours > STALE_HOURS) {
        staleCount++;
        recommendations.push({
          articleId: article.id,
          title: article.title,
          severity: "info",
          issue: `Article is ${Math.round(ageHours)}h old (>${STALE_HOURS}h threshold)`,
          recommendation: "Consider archiving or refreshing with updated data.",
        });
      }

      // 10. Broken image check
      if (article.imageUrl) {
        try {
          const imgRes = await fetch(article.imageUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
          if (!imgRes.ok) {
            brokenImages++;
            recommendations.push({
              articleId: article.id,
              title: article.title,
              severity: "warning",
              issue: `Image URL returned HTTP ${imgRes.status}`,
              recommendation: "Replace with a working Unsplash image URL.",
            });
          }
        } catch {
          brokenImages++;
          recommendations.push({
            articleId: article.id,
            title: article.title,
            severity: "warning",
            issue: "Image URL unreachable (timeout or network error)",
            recommendation: "Replace with a working Unsplash image URL.",
          });
        }
      }

      // 11. Earnings articles without stock chart
      if (
        (article.category === "earnings" || /\bearnings\b|\bguidance\b|\bEPS\b/i.test(article.title)) &&
        (!article.chartData || article.chartData.length === 0 ||
          !article.chartData.some((c) => c.chartLabel === "STOCK" || c.title.toLowerCase().includes("stock")))
      ) {
        const ticker = inferPrimaryTicker(article.title, article.story ?? "");
        if (ticker) {
          recommendations.push({
            articleId: article.id,
            title: article.title,
            severity: "info",
            issue: `Earnings article has no stock price chart for ${ticker}`,
            recommendation: `Add a ${ticker} stock price chart showing performance around the earnings announcement.`,
          });
        }
      }
    }

    // Save auto-fixes back to KV
    if (mutated) {
      collection.lastUpdated = new Date().toISOString();
      await kv.set("news", collection);
    }

    // Build report
    const articleCount = collection.news.length;
    const factCheckAvg = articleCount > 0 ? Math.round(totalFactCheck / articleCount) : 0;
    const confidenceAvg = articleCount > 0 ? Math.round((totalConfidence / articleCount) * 100) : 0;

    const criticalCount = recommendations.filter((r) => r.severity === "critical").length;
    const warningCount = recommendations.filter((r) => r.severity === "warning").length;

    let overallGrade = "A";
    if (criticalCount > 0) overallGrade = "D";
    else if (warningCount > 3) overallGrade = "C";
    else if (warningCount > 0) overallGrade = "B";

    const report: SweepReport = {
      timestamp: new Date().toISOString(),
      articlesChecked: articleCount,
      autoFixes,
      recommendations,
      health: {
        overallGrade,
        factCheckAvg,
        confidenceAvg,
        brokenImages,
        staleArticles: staleCount,
        hallucinations: hallucinationCount,
      },
    };

    // Save report to KV for dashboard access
    await kv.set("quality-sweep-latest", report);

    console.log(
      `[quality-sweep] Grade=${overallGrade} | checked=${articleCount} ` +
      `auto-fixed=${autoFixes.length} recommendations=${recommendations.length} ` +
      `(${criticalCount} critical, ${warningCount} warning) ` +
      `factCheckAvg=${factCheckAvg} confidenceAvg=${confidenceAvg}%`
    );

    return NextResponse.json(report);
  } catch (error) {
    console.error("[quality-sweep] Error:", error);
    return NextResponse.json(
      { error: "Quality sweep failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// GET — Return the latest sweep report (cached in KV)
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const validSecret = process.env.CRON_SECRET || process.env.FETCH_NEWS_SECRET;
  if (validSecret && authHeader !== `Bearer ${validSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  const report = await kv.get<SweepReport>("quality-sweep-latest");
  if (!report) {
    return NextResponse.json({ message: "No sweep report found. Run POST first." });
  }

  return NextResponse.json(report);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scrubHallucinations(story: string, hallucinations: string[]): string {
  if (!hallucinations || hallucinations.length === 0) return story;
  let cleaned = story;
  for (const hall of hallucinations) {
    const h = hall.trim();
    if (!h) continue;
    if (cleaned.includes(h)) {
      cleaned = cleaned.replace(h, "").replace(/[ \t]+\n/g, "\n");
      continue;
    }
    const words = h.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 4);
    if (words.length === 0) continue;
    const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z])/);
    const filtered = sentences.filter((s) => {
      const sl = s.toLowerCase();
      const matchCount = words.filter((w) => sl.includes(w)).length;
      return matchCount / words.length < 0.6;
    });
    if (filtered.length < sentences.length) cleaned = filtered.join(" ");
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Infer the primary company ticker from the article title/body.
 * Uses a mapping of well-known company names → tickers.
 */
function inferPrimaryTicker(title: string, story: string): string | null {
  const text = `${title} ${story}`.toLowerCase();
  const COMPANY_TICKERS: [RegExp, string][] = [
    [/\blululemon\b/i, "LULU"],
    [/\bnike\b/i, "NKE"],
    [/\bapple\b/i, "AAPL"],
    [/\btesla\b/i, "TSLA"],
    [/\bnvidia\b|\bnvda\b/i, "NVDA"],
    [/\bmeta\b.*\bplatforms?\b|\bfacebook\b/i, "META"],
    [/\bgoogle\b|\balphabet\b/i, "GOOGL"],
    [/\bamazon\b/i, "AMZN"],
    [/\bmicrosoft\b/i, "MSFT"],
    [/\bhumana\b/i, "HUM"],
    [/\bfirst solar\b/i, "FSLR"],
    [/\bnextracker\b/i, "NXT"],
    [/\bpenske\b/i, "PAG"],
    [/\bsprouts\b/i, "SFM"],
    [/\bboeing\b/i, "BA"],
    [/\bjpmorgan\b|\bjp morgan\b/i, "JPM"],
    [/\bgoldman sachs\b/i, "GS"],
    [/\bwalmart\b/i, "WMT"],
    [/\bcostco\b/i, "COST"],
    [/\bunitedhealth\b/i, "UNH"],
    [/\bpfizer\b/i, "PFE"],
    [/\bjohnson & johnson\b/i, "JNJ"],
    [/\bcoinbase\b/i, "COIN"],
    [/\bpalantir\b/i, "PLTR"],
    [/\bcrowdstrike\b/i, "CRWD"],
    [/\bsnowflake\b/i, "SNOW"],
    [/\bdelta air\b/i, "DAL"],
    [/\bunited airlines\b/i, "UAL"],
    [/\bamerican airlines\b/i, "AAL"],
    [/\bsouthwest\b/i, "LUV"],
    [/\bibm\b/i, "IBM"],
    [/\bon holding\b/i, "ONON"],
    [/\bgeely\b/i, "GELYF"],
    [/\bbentley\b/i, "BNTGY"],
  ];

  for (const [regex, ticker] of COMPANY_TICKERS) {
    if (regex.test(text)) return ticker;
  }
  return null;
}
