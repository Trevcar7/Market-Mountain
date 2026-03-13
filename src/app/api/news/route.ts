import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { NewsCollection } from "@/lib/news-types";

export const maxDuration = 10;
export const runtime = "nodejs";

/**
 * GET /api/news
 * Serves active news data from Vercel KV (Upstash Redis)
 */
export async function GET() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    // DEV PREVIEW: return sample news to visualize design
    if (process.env.NODE_ENV === "development") {
      const now = Date.now();
      return NextResponse.json({
        lastUpdated: new Date().toISOString(),
        source: "Dev mock data",
        news: [
          { id: "dev-1", title: "Federal Reserve Holds Rates Steady, Signals Cautious Path Ahead", story: "The Federal Reserve held its benchmark interest rate unchanged at 5.25–5.50% on Wednesday, as policymakers opted for caution amid persistent inflation and signs of labor market resilience.\n\nChair Jerome Powell acknowledged the challenging balancing act, noting that while inflation has eased from its 2022 peaks, it remains above the 2% target. The Fed's preferred inflation gauge, the PCE index, stood at 2.8% in January.\n\nMarkets rallied on the announcement, with the S&P 500 gaining 0.8% as investors interpreted the hold as a sign the Fed would not tighten further. Treasury yields fell slightly, with the 10-year note dropping to 4.15%.\n\nThe committee reiterated its data-dependent approach, with most members projecting two quarter-point cuts by year-end — down from three projected in December.", category: "macro", publishedAt: new Date(now).toISOString(), importance: 9, sentiment: "neutral", relatedTickers: ["SPY", "TLT", "GLD"], sourcesUsed: [{ title: "Fed holds", url: "#", source: "Reuters" }, { title: "Powell", url: "#", source: "Bloomberg" }], synthesizedBy: "Claude", factCheckScore: 85, verifiedClaims: [] },
          { id: "dev-2", title: "Apple Reports Record Services Revenue, Beats Q1 Earnings Estimates", story: "Apple Inc. reported record quarterly services revenue of $23.1 billion in its fiscal first quarter, beating analyst estimates by $800 million and providing a bright spot amid continued weakness in iPhone unit sales.", category: "earnings", publishedAt: new Date(now - 3600000).toISOString(), importance: 8, sentiment: "positive", relatedTickers: ["AAPL", "QQQ"], sourcesUsed: [{ title: "AAPL Q1", url: "#", source: "CNBC" }], synthesizedBy: "Claude", factCheckScore: 82, verifiedClaims: [] },
          { id: "dev-3", title: "Oil Prices Slide as OPEC+ Supply Concerns Ease", story: "Brent crude fell 2.3% to $81.40 per barrel on Thursday after OPEC+ sources indicated the cartel is unlikely to extend voluntary supply cuts beyond Q2 2024.", category: "markets", publishedAt: new Date(now - 7200000).toISOString(), importance: 7, sentiment: "negative", relatedTickers: ["USO", "XLE"], sourcesUsed: [{ title: "OPEC", url: "#", source: "Reuters" }], synthesizedBy: "Claude", factCheckScore: 78, verifiedClaims: [] },
          { id: "dev-4", title: "Bitcoin Climbs Past $70,000 as Spot ETF Inflows Accelerate", story: "Bitcoin surpassed $70,000 for the first time since November 2021, driven by a surge in institutional inflows into newly approved spot Bitcoin ETFs totaling $1.2 billion in a single day.", category: "crypto", publishedAt: new Date(now - 10800000).toISOString(), importance: 7, sentiment: "positive", relatedTickers: ["BTC", "IBIT", "FBTC"], sourcesUsed: [{ title: "BTC rally", url: "#", source: "CoinDesk" }], synthesizedBy: "Claude", factCheckScore: 80, verifiedClaims: [] },
        ],
        meta: { totalCount: 4, nextUpdate: new Date().toISOString() },
      });
    }
    return NextResponse.json(
      {
        lastUpdated: new Date().toISOString(),
        source: "No news fetched yet",
        news: [],
        meta: {
          totalCount: 0,
          nextUpdate: new Date().toISOString(),
          archiveUrl: "/api/news-archive",
        },
      },
      { status: 200 }
    );
  }

  try {
    const kv = new Redis({ url, token });
    const newsData = await kv.get<NewsCollection>("news");

    if (!newsData) {
      return NextResponse.json(
        {
          lastUpdated: new Date().toISOString(),
          source: "No news fetched yet",
          news: [],
          meta: {
            totalCount: 0,
            nextUpdate: new Date().toISOString(),
            archiveUrl: "/api/news-archive",
          },
        },
        { status: 200 }
      );
    }

    return NextResponse.json(newsData, {
      status: 200,
      headers: {
        // CDN caches for 90s; serves stale for 30s while revalidating — new stories appear within ~90s
        "Cache-Control": "public, s-maxage=90, stale-while-revalidate=30, max-age=30",
      },
    });
  } catch (error) {
    console.error("Error reading news from KV:", error);
    return NextResponse.json(
      {
        error: "Failed to read news",
        lastUpdated: new Date().toISOString(),
        news: [],
        meta: { totalCount: 0 },
      },
      { status: 500 }
    );
  }
}
