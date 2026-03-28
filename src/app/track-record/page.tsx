import type { Metadata } from "next";
import Link from "next/link";
import { extractPicks } from "@/lib/track-record";
import { fetchFmpQuote } from "@/lib/market-data";

export const revalidate = 300; // ISR: 5 min

export const metadata: Metadata = {
  title: "Track Record",
  description:
    "Transparent performance tracking of all Market Mountain equity research picks — price targets, returns, and win rates.",
};

const ratingColors: Record<string, string> = {
  buy: "bg-accent-100 text-accent-700",
  hold: "bg-amber-100 text-amber-700",
  sell: "bg-red-100 text-red-700",
  watchlist: "bg-navy-100 text-navy-600",
  neutral: "bg-slate-100 text-slate-600",
};

const ratingLabels: Record<string, string> = {
  buy: "Buy",
  hold: "Hold",
  sell: "Sell",
  watchlist: "Watchlist",
  neutral: "Neutral",
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function TrackRecordPage() {
  const picks = extractPicks();

  // Fetch live prices
  const uniqueTickers = [...new Set(picks.map((p) => p.ticker))];
  const priceMap = new Map<string, number>();

  await Promise.allSettled(
    uniqueTickers.map(async (ticker) => {
      const price = await fetchFmpQuote(ticker);
      console.log(`[track-record] FMP quote for ${ticker}: ${price ?? "null (API unavailable or key missing)"}`);
      if (price) priceMap.set(ticker, price);
    })
  );

  console.log(`[track-record] Prices fetched: ${priceMap.size}/${uniqueTickers.length} tickers — FMP_API_KEY ${process.env.FMP_API_KEY ? "set" : "MISSING"}`);

  // Enrich with live data
  const enrichedPicks = picks.map((pick) => {
    const currentPrice = priceMap.get(pick.ticker);
    const returnPct = currentPrice
      ? ((currentPrice - pick.priceAtPublish) / pick.priceAtPublish) * 100
      : null;
    // hitTarget: use confirmed frontmatter flag, OR live price check as fallback
    const hitTarget = pick.targetHitConfirmed || (currentPrice ? currentPrice >= pick.priceTarget : false);
    return { ...pick, currentPrice, returnPct, hitTarget };
  });

  // Aggregate stats
  const withReturns = enrichedPicks.filter((p) => p.returnPct !== null || p.targetHitConfirmed);
  const winners = withReturns.filter((p) => (p.returnPct ?? 0) > 0 || p.targetHitConfirmed);
  const targetHits = enrichedPicks.filter((p) => p.hitTarget);
  const avgReturn =
    withReturns.length > 0
      ? withReturns.reduce((sum, p) => sum + (p.returnPct ?? 0), 0) / withReturns.length
      : 0;

  return (
    <div className="min-h-screen bg-surface">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <p className="text-accent-400 text-xs font-semibold tracking-[0.2em] uppercase mb-3">
            PERFORMANCE TRANSPARENCY
          </p>
          <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Track Record
          </h1>
          <p className="text-white/60 text-lg max-w-2xl leading-relaxed">
            Every price target. Every pick. Tracked in real time against live market
            data. No cherry-picking — full transparency.
          </p>
        </div>
      </section>

      {/* Stats Cards */}
      {enrichedPicks.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 -mt-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-text">{enrichedPicks.length}</p>
              <p className="text-xs text-text-muted mt-1">Total Picks</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-accent-600">
                {enrichedPicks.length > 0 ? Math.round((winners.length / enrichedPicks.length) * 100) : 0}%
              </p>
              <p className="text-xs text-text-muted mt-1">Win Rate</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className={`text-2xl font-bold ${avgReturn >= 0 ? "text-accent-600" : "text-red-500"}`}>
                {avgReturn >= 0 ? "+" : ""}{avgReturn.toFixed(1)}%
              </p>
              <p className="text-xs text-text-muted mt-1">Avg Return</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-accent-600">
                {targetHits.length}/{enrichedPicks.length}
              </p>
              <p className="text-xs text-text-muted mt-1">Targets Hit</p>
            </div>
          </div>
        </section>
      )}

      {/* Picks Table */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 py-10 sm:py-14">
        <h2 className="text-lg font-serif font-bold text-text mb-6">
          All Research Picks
        </h2>

        <div className="space-y-4">
          {enrichedPicks.map((pick) => {
            const targetUpside = ((pick.priceTarget - pick.priceAtPublish) / pick.priceAtPublish) * 100;
            return (
              <Link
                key={`${pick.ticker}-${pick.date}`}
                href={`/post/${pick.slug}`}
                className="block bg-card rounded-xl border border-border shadow-sm hover:border-accent-300 hover:shadow-md transition-all overflow-hidden"
              >
                {/* Card header */}
                <div className="px-5 pt-5 pb-3">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-lg font-bold text-text">{pick.ticker}</span>
                    <span
                      className={`text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded ${
                        ratingColors[pick.rating] ?? ratingColors.neutral
                      }`}
                    >
                      {ratingLabels[pick.rating] ?? pick.rating}
                    </span>
                    {pick.hitTarget && (
                      <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-accent-500 text-white flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        TARGET HIT
                      </span>
                    )}
                    <span className="text-[11px] text-text-light ml-auto">{formatDate(pick.date)}</span>
                  </div>
                  <p className="text-sm text-text-muted line-clamp-1">{pick.title}</p>
                </div>

                {/* Price data grid */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-border">
                  {/* Entry Price */}
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Entry</p>
                    <p className="text-base font-bold text-text">${pick.priceAtPublish}</p>
                  </div>

                  {/* Price Target */}
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Target</p>
                    <p className="text-base font-bold text-accent-600">${pick.priceTarget}</p>
                    <p className="text-[11px] text-accent-600 font-medium">+{targetUpside.toFixed(0)}% upside</p>
                  </div>

                  {/* Current Price */}
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Current</p>
                    <p className="text-base font-bold text-text">
                      {pick.currentPrice ? `$${pick.currentPrice.toFixed(2)}` : "—"}
                    </p>
                  </div>

                  {/* Current Return (live) */}
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Return</p>
                    {pick.returnPct !== null ? (
                      <>
                        <p className={`text-base font-bold ${pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                          {pick.returnPct >= 0 ? "+" : ""}{pick.returnPct.toFixed(1)}%
                        </p>
                        <p className={`text-[11px] font-medium ${pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                          {pick.returnPct >= 0 ? "+" : ""}${pick.currentPrice ? (pick.currentPrice - pick.priceAtPublish).toFixed(2) : "—"}/share
                        </p>
                      </>
                    ) : (
                      <p className="text-base text-text-light">—</p>
                    )}
                  </div>

                  {/* Status */}
                  <div className="bg-card px-4 py-3 col-span-2 sm:col-span-1">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Status</p>
                    {pick.hitTarget ? (
                      <div className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 text-accent-500" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        <span className="text-sm font-semibold text-accent-600">Target Reached</span>
                      </div>
                    ) : pick.returnPct !== null && pick.returnPct > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                        </svg>
                        <span className="text-sm font-medium text-accent-600">In Profit</span>
                      </div>
                    ) : pick.returnPct !== null ? (
                      <div className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="text-sm font-medium text-amber-600">Active</span>
                      </div>
                    ) : (
                      <span className="text-sm text-text-light">Tracking</span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* Disclaimer */}
        <p className="text-xs text-text-light mt-6 leading-relaxed max-w-2xl">
          Performance data is based on closing prices at the time of publication and live market
          prices from Financial Modeling Prep. Past performance does not guarantee future results.
          All investment research is for informational purposes only and does not constitute
          financial advice.
        </p>
      </section>
    </div>
  );
}
