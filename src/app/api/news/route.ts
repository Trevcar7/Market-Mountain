import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection } from "@/lib/news-types";
import { SUPPRESSED_ARTICLE_IDS } from "@/lib/suppressed-articles";
import { MARCH_13_CUTOFF_MS } from "@/lib/constants";

/**
 * GET /api/news
 * Serves active news data from Vercel KV (Upstash Redis)
 */
export async function GET() {
  const kv = getRedisClient();

  if (!kv) {
    // DEV PREVIEW: return sample news to visualize design
    if (process.env.NODE_ENV === "development") {
      const now = Date.now();
      return NextResponse.json({
        lastUpdated: new Date().toISOString(),
        source: "Dev mock data",
        news: [
          { id: "dev-1", title: "Federal Reserve Holds Rates Steady, Signals Cautious Path Ahead", story: "The Federal Reserve held its benchmark interest rate unchanged at 5.25–5.50% on Wednesday, as policymakers opted for caution amid persistent inflation and signs of labor market resilience.\n\nChair Jerome Powell acknowledged the challenging balancing act, noting that while inflation has eased from its 2022 peaks, it remains above the 2% target. The Fed's preferred inflation gauge, the PCE index, stood at 2.8% in January.\n\nMarkets rallied on the announcement, with the S&P 500 gaining 0.8% as investors interpreted the hold as a sign the Fed would not tighten further. Treasury yields fell slightly, with the 10-year note dropping to 4.15%.\n\nThe committee reiterated its data-dependent approach, with most members projecting two quarter-point cuts by year-end — down from three projected in December.", category: "macro", imageUrl: "https://images.unsplash.com/photo-1621944190310-e3cca1564bd7?w=1200&q=80", publishedAt: new Date(now).toISOString(), importance: 9, sentiment: "neutral", relatedTickers: ["SPY", "TLT", "GLD"], sourcesUsed: [{ title: "Fed holds", url: "#", source: "Reuters" }, { title: "Powell", url: "#", source: "Bloomberg" }], synthesizedBy: "Claude", factCheckScore: 85, verifiedClaims: [] },
          { id: "dev-2", title: "Apple Reports Record Services Revenue, Beats Q1 Earnings Estimates", story: "Apple Inc. reported record quarterly services revenue of $23.1 billion in its fiscal first quarter, beating analyst estimates by $800 million and providing a bright spot amid continued weakness in iPhone unit sales.", category: "earnings", imageUrl: "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80", publishedAt: new Date(now - 3600000).toISOString(), importance: 8, sentiment: "positive", relatedTickers: ["AAPL", "QQQ"], sourcesUsed: [{ title: "AAPL Q1", url: "#", source: "CNBC" }], synthesizedBy: "Claude", factCheckScore: 82, verifiedClaims: [] },
          { id: "dev-3", title: "Oil Prices Slide as OPEC+ Supply Concerns Ease", story: "Brent crude fell 2.3% to $81.40 per barrel on Thursday after OPEC+ sources indicated the cartel is unlikely to extend voluntary supply cuts beyond Q2 2024.", category: "markets", imageUrl: "https://images.unsplash.com/photo-1466611653911-95081537e5b7?w=1200&q=80", publishedAt: new Date(now - 7200000).toISOString(), importance: 7, sentiment: "negative", relatedTickers: ["USO", "XLE"], sourcesUsed: [{ title: "OPEC", url: "#", source: "Reuters" }], synthesizedBy: "Claude", factCheckScore: 78, verifiedClaims: [] },
          { id: "dev-4", title: "Bitcoin Climbs Past $70,000 as Spot ETF Inflows Accelerate", story: "Bitcoin surpassed $70,000 for the first time since November 2021, driven by a surge in institutional inflows into newly approved spot Bitcoin ETFs totaling $1.2 billion in a single day.", category: "crypto", imageUrl: "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80", publishedAt: new Date(now - 10800000).toISOString(), importance: 7, sentiment: "positive", relatedTickers: ["BTC", "IBIT", "FBTC"], sourcesUsed: [{ title: "BTC rally", url: "#", source: "CoinDesk" }], synthesizedBy: "Claude", factCheckScore: 80, verifiedClaims: [] },
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

    // Filter out suppressed articles and all March 12 content (pre-March 13 batch)
    const STRIP_FIELDS = new Set(["synthesizedBy", "toneMatch"]);

    // ── Article patches: override bad/missing images and miscategorized articles ──
    const ARTICLE_PATCHES: Array<{
      test: RegExp;
      imageUrl: string;
      category?: string;
      relatedTickers?: Record<string, string>;
    }> = [
      // NVIDIA → GPU close-up
      { test: /\bnvidia\b|\bNVDA\b/i, imageUrl: "https://images.unsplash.com/photo-1587202372775-e229f172b9d7?w=1200&q=80" },
      // Bentley → luxury car
      { test: /\bbentley\b/i, imageUrl: "https://images.unsplash.com/photo-1661683769067-1ebc0e7aa7b6?w=1200&q=80", relatedTickers: { TSLA: "VWAGY" } },
      // Humana / managed care → healthcare
      { test: /\bhumana\b|\bmanaged care\b/i, imageUrl: "https://images.unsplash.com/photo-1638202993928-7267aad84c31?w=1200&q=80" },
      // Apple + IBM M&A → tech corporate
      { test: /\bibm\b.*\bapple\b|\bapple\b.*\bibm\b/i, imageUrl: "https://images.unsplash.com/photo-1722537273895-b35dfbd273ee?w=1200&q=80" },
      // MLB / baseball / sports betting → baseball stadium (not earnings)
      { test: /\bmlb\b|\bbaseball\b|\bsports betting\b/i, imageUrl: "https://images.unsplash.com/photo-1471295253337-3ceaaedca402?w=1200&q=80", category: "markets" },
      // Meta / Facebook content moderation → social media tech (not earnings)
      { test: /\bmeta\b.*\bcontent\b|\bmeta\b.*\bmoderation\b|\bmeta\b.*\bfacebook\b/i, imageUrl: "https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=1200&q=80", category: "markets" },
      // OpenAI / AI acquisition → AI tech (not earnings, it's M&A)
      { test: /\bopenai\b/i, imageUrl: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80", category: "markets" },
      // Iran / geopolitical conflict + energy → oil refinery
      { test: /\biran\b.*\bstrike\b|\biran\b.*\bcrude\b|\biran\b.*\boil\b/i, imageUrl: "https://images.unsplash.com/photo-1513828583688-c52646db42da?w=1200&q=80" },
      // Lululemon / athletic retail → retail store
      { test: /\blululemon\b/i, imageUrl: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200&q=80" },
      // Stagflation / GDP collapse → trading screens
      { test: /\bstagflation\b/i, imageUrl: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80" },
      // Jio / Reliance IPO → India market
      { test: /\bjio\b|\breliance\b/i, imageUrl: "https://images.unsplash.com/photo-1468254095679-bbcba94a7066?w=1200&q=80" },
    ];

    // Category-level fallbacks for any article still missing an image after patches
    const CATEGORY_FALLBACK_IMAGES: Record<string, string> = {
      macro: "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1200&q=80",
      earnings: "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80",
      markets: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
      crypto: "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80",
      policy: "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=1200&q=80",
    };

    const filteredNews = newsData.news
      .filter(
        (item) =>
          !SUPPRESSED_ARTICLE_IDS.has(item.id) &&
          new Date(item.publishedAt).getTime() >= MARCH_13_CUTOFF_MS
      )
      .map((item) => {
        let patchedItem = { ...item };
        const title = patchedItem.title ?? "";

        // Apply keyword-based patches (image, category, tickers)
        for (const patch of ARTICLE_PATCHES) {
          if (patch.test.test(title)) {
            patchedItem.imageUrl = patch.imageUrl;
            if (patch.category) {
              patchedItem.category = patch.category as typeof patchedItem.category;
            }
            if (patch.relatedTickers && patchedItem.relatedTickers) {
              patchedItem.relatedTickers = patchedItem.relatedTickers.map(
                (t) => patch.relatedTickers![t] ?? t
              );
            }
            break;
          }
        }

        // Category fallback: if still no image, use a category-appropriate one
        if (!patchedItem.imageUrl) {
          patchedItem.imageUrl = CATEGORY_FALLBACK_IMAGES[patchedItem.category] ?? CATEGORY_FALLBACK_IMAGES.macro;
        }

        return Object.fromEntries(
          Object.entries(patchedItem).filter(([k]) => !STRIP_FIELDS.has(k))
        ) as unknown as typeof item;
      });
    const filtered = { ...newsData, news: filteredNews, meta: { ...newsData.meta, totalCount: filteredNews.length } };

    return NextResponse.json(filtered, {
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
