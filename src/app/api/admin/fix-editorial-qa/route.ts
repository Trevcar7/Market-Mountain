import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";
import { buildNewsChartData } from "@/lib/market-data";

// One-time editorial QA patch — delete after use.
// Token: e3f5a1b7c9d2e4f6a8b0c1d3e5f7a9b2
const ADMIN_TOKEN = "e3f5a1b7c9d2e4f6a8b0c1d3e5f7a9b2";

// Confirmed editorial image replacements
const FED_BUILDING    = "https://images.unsplash.com/photo-1569025591598-35bcd6438bda?w=1200&q=80";
const OIL_PLATFORM   = "https://images.unsplash.com/photo-1466611653911-95081537e5b7?w=1200&q=80";

// Images known to be wrong for their article topic
const BAD_INFLATION_IMAGES = new Set([
  "photo-1542838132-92c53300491e", // grocery store (produce aisle)
  "photo-1590283603385-17ffb3a7f29f", // generic financial bar chart (crypto-looking)
  "photo-1579621970563",              // money plant (growth context, wrong)
]);

// Known-bad images on oil/energy articles: NYSE-style stock exchange images
const BAD_OIL_IMAGES = new Set([
  "photo-1761233138997-44d9b002a08f", // suspected NYSE/stock exchange
  "photo-1570096091861-28b7d458e960", // unknown — replace to be safe with confirmed oil image
]);

function extractPhotoId(url: string | undefined): string {
  if (!url) return "";
  const m = url.match(/photo-([a-zA-Z0-9\-]+)/);
  return m ? `photo-${m[1]}` : url;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dry = req.nextUrl.searchParams.get("dry") === "1";

  const url = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!url || !kvToken) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  const kv = new Redis({ url, token: kvToken });
  const data = await kv.get<NewsCollection>("news");
  if (!data?.news?.length) {
    return NextResponse.json({ error: "No articles found" }, { status: 404 });
  }

  const report: string[] = [];
  let changed = 0;
  const updatedNews = data.news.map((article) => {
    let updated = { ...article };
    const patches: string[] = [];
    const photoId = extractPhotoId(article.imageUrl);

    // ── 1. Fix inflation article images ────────────────────────────────────
    if (article.topicKey === "inflation" && BAD_INFLATION_IMAGES.has(photoId)) {
      patches.push(`image: ${photoId} → Fed building`);
      updated = { ...updated, imageUrl: FED_BUILDING };
    }

    // ── 2. Fix oil/broad_market articles that have wrong images ────────────
    const isOilArticle =
      article.topicKey === "energy" ||
      (article.topicKey === "broad_market" &&
        /\boil\b|crude\b|WTI\b|brent\b|OPEC\b|petroleum/i.test(article.title));

    if (isOilArticle && BAD_OIL_IMAGES.has(photoId)) {
      patches.push(`image: ${photoId} → oil platform`);
      updated = { ...updated, imageUrl: OIL_PLATFORM };
    }

    // ── 3. Patch inflation chart: add referenceValue (Fed 2% target) ───────
    if (
      article.topicKey === "inflation" &&
      article.chartData &&
      article.chartData.referenceValue === undefined
    ) {
      patches.push(`chart: added referenceValue=2.0 (Fed 2% Target)`);
      updated = {
        ...updated,
        chartData: {
          ...article.chartData,
          referenceValue: 2.0,
          referenceLabel: "Fed 2% Target",
        },
      };
    }

    if (patches.length > 0) {
      changed++;
      report.push(`✓ ${article.id} [${article.topicKey}] "${article.title.slice(0, 60)}"`);
      patches.forEach((p) => report.push(`   ${p}`));
    }
    return updated;
  });

  // ── 4. Add WTI chart to oil/energy articles that are missing one ─────────
  // (requires async calls, handle separately)
  const withCharts = await Promise.all(
    updatedNews.map(async (article) => {
      const isOil =
        article.topicKey === "energy" ||
        (article.topicKey === "broad_market" &&
          /\boil\b|crude\b|WTI\b|brent\b|OPEC\b|petroleum/i.test(article.title));

      if (isOil && !article.chartData) {
        try {
          const chart = await buildNewsChartData("energy");
          if (chart) {
            changed++;
            report.push(`✓ ${article.id} [${article.topicKey}] "${article.title.slice(0, 60)}"`);
            report.push(`   chart: (none) → "${chart.title}"`);
            return { ...article, chartData: chart };
          }
        } catch (err) {
          report.push(`  [chart error] ${article.id}: ${String(err)}`);
        }
      }
      return article;
    })
  );

  if (!dry && changed > 0) {
    await kv.set("news", { ...data, news: withCharts });
  }

  return NextResponse.json({
    dry,
    articlesScanned: data.news.length,
    articlesChanged: changed,
    report,
  });
}
