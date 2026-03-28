import { NextResponse } from "next/server";
import { extractPicks, TrackRecordPick } from "@/lib/track-record";
import { fetchFmpQuote } from "@/lib/market-data";

export const revalidate = 300; // ISR: refresh every 5 minutes

/**
 * GET /api/track-record
 *
 * Returns all research picks with live prices from FMP.
 * Computes return since publish, whether target was hit, and aggregate stats.
 */
export async function GET() {
  const picks = extractPicks();

  if (picks.length === 0) {
    return NextResponse.json({ picks: [], stats: null });
  }

  // Fetch live prices for all unique tickers
  const uniqueTickers = [...new Set(picks.map((p) => p.ticker))];
  const priceMap = new Map<string, number>();

  const priceResults = await Promise.allSettled(
    uniqueTickers.map(async (ticker) => {
      const price = await fetchFmpQuote(ticker);
      if (price) priceMap.set(ticker, price);
    })
  );

  // Also fetch SPY for benchmark comparison
  const spyPrice = await fetchFmpQuote("SPY");

  // Enrich picks with live data
  const enrichedPicks: TrackRecordPick[] = picks.map((pick) => {
    const currentPrice = priceMap.get(pick.ticker);
    const returnSincePublish = currentPrice
      ? ((currentPrice - pick.priceAtPublish) / pick.priceAtPublish) * 100
      : undefined;
    const hitTarget = currentPrice ? currentPrice >= pick.priceTarget : undefined;

    return {
      ...pick,
      currentPrice,
      returnSincePublish,
      hitTarget,
    };
  });

  // Aggregate stats
  const withReturns = enrichedPicks.filter((p) => p.returnSincePublish !== undefined);
  const winners = withReturns.filter((p) => (p.returnSincePublish ?? 0) > 0);
  const targetHits = withReturns.filter((p) => p.hitTarget);

  const stats = withReturns.length > 0
    ? {
        totalPicks: withReturns.length,
        winners: winners.length,
        winRate: Math.round((winners.length / withReturns.length) * 100),
        avgReturn: Math.round(
          withReturns.reduce((sum, p) => sum + (p.returnSincePublish ?? 0), 0) /
            withReturns.length * 10
        ) / 10,
        targetHitRate: Math.round((targetHits.length / withReturns.length) * 100),
        bestPick: withReturns.reduce((best, p) =>
          (p.returnSincePublish ?? 0) > (best.returnSincePublish ?? 0) ? p : best
        ),
        spyPrice,
      }
    : null;

  // Sort by date (newest first), but suppress stale results
  void priceResults; // Acknowledge settled results

  return NextResponse.json(
    { picks: enrichedPicks, stats },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    }
  );
}
