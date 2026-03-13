import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";

export const maxDuration = 15;
export const runtime = "nodejs";

const ONE_TIME_TOKEN = "c4d1e8f2a5b7c3d9e0f1a2b4c6d8e0f2";

// Financial bar chart — neutral, data-driven, appropriate for inflation/CPI coverage
const INFLATION_IMAGE =
  "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80";

// The two photo IDs that triggered plant/growth imagery
const BAD_IDS = ["1579621970563", "1632175771754"];

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (token !== ONE_TIME_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  const kv = new Redis({ url: kvUrl, token: kvToken });
  const newsData = await kv.get<NewsCollection>("news");
  if (!newsData) return NextResponse.json({ error: "No data" }, { status: 404 });

  const patched: string[] = [];
  const updated = newsData.news.map((article) => {
    if (BAD_IDS.some((id) => article.imageUrl?.includes(id))) {
      patched.push(`${article.id}: "${article.title}"`);
      return { ...article, imageUrl: INFLATION_IMAGE };
    }
    return article;
  });

  await kv.set("news", { ...newsData, lastUpdated: new Date().toISOString(), news: updated });

  return NextResponse.json({ success: true, patched });
}
