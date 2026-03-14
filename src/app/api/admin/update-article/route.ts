import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";

export const maxDuration = 30;
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expectedToken = process.env.FETCH_NEWS_SECRET;

  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }

  let id: string;
  let fields: Record<string, unknown>;
  try {
    const body = await request.json();
    if (!body.id || typeof body.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    if (!body.fields || typeof body.fields !== "object") {
      return NextResponse.json({ error: "fields is required" }, { status: 400 });
    }
    id = body.id;
    fields = body.fields;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const kv = new Redis({ url, token });

  try {
    const newsData = await kv.get<NewsCollection>("news");
    if (!newsData) return NextResponse.json({ error: "No news data in KV" }, { status: 404 });

    const idx = newsData.news.findIndex((n) => n.id === id);
    if (idx === -1) {
      return NextResponse.json(
        { error: `Article not found: ${id}`, available: newsData.news.map((n) => n.id) },
        { status: 404 }
      );
    }

    const updated = { ...newsData.news[idx], ...fields };
    const newNews = [...newsData.news];
    newNews[idx] = updated;

    await kv.set("news", { ...newsData, lastUpdated: new Date().toISOString(), news: newNews });

    return NextResponse.json({
      success: true,
      updated: { id: updated.id, title: updated.title },
      patchedFields: Object.keys(fields),
    });
  } catch (err) {
    return NextResponse.json({ error: "KV error", detail: String(err) }, { status: 500 });
  }
}
