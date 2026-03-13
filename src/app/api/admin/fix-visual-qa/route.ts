import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";
import { buildNewsChartData } from "@/lib/market-data";

// One-time admin endpoint — delete after use
// Token: d2e4f1a8b3c5d7e9f0a1b2c3d4e5f6a7
const ADMIN_TOKEN = "d2e4f1a8b3c5d7e9f0a1b2c3d4e5f6a7";

const NEW_INFLATION_IMAGE =
  "https://images.unsplash.com/photo-1542838132-92c53300491e?w=1200&q=80";

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
  const updatedNews = [...data.news];

  for (let i = 0; i < updatedNews.length; i++) {
    const article = updatedNews[i];
    const patches: string[] = [];

    // ── Fix inflation image ──────────────────────────────────────────────────
    if (article.topicKey === "inflation") {
      const currentImg = article.imageUrl ?? "(none)";
      const isBadImage =
        !article.imageUrl ||
        article.imageUrl.includes("photo-1590283603385") || // financial bar chart (crypto-looking)
        article.imageUrl.includes("photo-1579621970563") || // money plant (wrong context)
        article.imageUrl.includes("photo-1632175771754") || // flagged in previous patch
        article.imageUrl.includes("photo-1681684564271");  // flagged in previous patch

      if (isBadImage) {
        patches.push(`image: ${currentImg} → grocery store`);
        if (!dry) updatedNews[i] = { ...article, imageUrl: NEW_INFLATION_IMAGE };
      }

      // ── Recompute CPI chart (YoY % instead of raw index) ───────────────────
      try {
        const newChart = await buildNewsChartData("inflation");
        if (newChart) {
          const oldTitle = article.chartData?.title ?? "(none)";
          const isBetterChart =
            !article.chartData ||
            article.chartData.unit === "Index"; // Raw index → replace with YoY %

          if (isBetterChart) {
            patches.push(`chart: "${oldTitle}" → "${newChart.title}" (unit: ${newChart.unit})`);
            if (!dry) updatedNews[i] = { ...updatedNews[i], chartData: newChart };
          }
        }
      } catch (err) {
        report.push(`  [chart error] ${article.id}: ${String(err)}`);
      }
    }

    // ── Add WTI chart to energy/oil articles missing a chart ─────────────────
    if (article.topicKey === "energy" && !article.chartData) {
      try {
        const newChart = await buildNewsChartData("energy");
        if (newChart) {
          patches.push(`chart: (none) → "${newChart.title}"`);
          if (!dry) updatedNews[i] = { ...updatedNews[i], chartData: newChart };
        }
      } catch (err) {
        report.push(`  [chart error] ${article.id}: ${String(err)}`);
      }
    }

    if (patches.length > 0) {
      changed++;
      report.push(`✓ ${article.id} (${article.topicKey}): ${patches.join(" | ")}`);
    }
  }

  if (!dry && changed > 0) {
    await kv.set("news", { ...data, news: updatedNews });
  }

  return NextResponse.json({
    dry,
    articlesScanned: data.news.length,
    articlesChanged: changed,
    report,
  });
}
