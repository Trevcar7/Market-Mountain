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
      if (price) priceMap.set(ticker, price);
    })
  );

  // Enrich with live data
  const enrichedPicks = picks.map((pick) => {
    const currentPrice = priceMap.get(pick.ticker);
    const returnPct = currentPrice
      ? ((currentPrice - pick.priceAtPublish) / pick.priceAtPublish) * 100
      : null;
    const hitTarget = currentPrice ? currentPrice >= pick.priceTarget : null;
    return { ...pick, currentPrice, returnPct, hitTarget };
  });

  // Aggregate stats
  const withReturns = enrichedPicks.filter((p) => p.returnPct !== null);
  const winners = withReturns.filter((p) => (p.returnPct ?? 0) > 0);
  const targetHits = withReturns.filter((p) => p.hitTarget);
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
      {withReturns.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 -mt-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-text">{withReturns.length}</p>
              <p className="text-xs text-text-muted mt-1">Total Picks</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-accent-600">
                {Math.round((winners.length / withReturns.length) * 100)}%
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
                {targetHits.length}/{withReturns.length}
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

        <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
          {/* Table header */}
          <div className="hidden sm:grid sm:grid-cols-7 gap-4 px-5 py-3 bg-surface-2 text-[10px] font-bold tracking-widest uppercase text-text-light border-b border-border">
            <span className="col-span-2">Stock</span>
            <span>Rating</span>
            <span className="text-right">Entry</span>
            <span className="text-right">Target</span>
            <span className="text-right">Current</span>
            <span className="text-right">Return</span>
          </div>

          {/* Rows */}
          {enrichedPicks.map((pick) => (
            <Link
              key={`${pick.ticker}-${pick.date}`}
              href={`/post/${pick.slug}`}
              className="block sm:grid sm:grid-cols-7 gap-4 px-5 py-4 border-b border-border last:border-b-0 hover:bg-surface transition-colors"
            >
              {/* Stock info */}
              <div className="col-span-2 mb-2 sm:mb-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-text">{pick.ticker}</span>
                  <span
                    className={`text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded ${
                      ratingColors[pick.rating] ?? ratingColors.neutral
                    }`}
                  >
                    {ratingLabels[pick.rating] ?? pick.rating}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-0.5 line-clamp-1">{pick.title}</p>
                <p className="text-[11px] text-text-light">{formatDate(pick.date)}</p>
              </div>

              {/* Rating (hidden on mobile, shown in stock info) */}
              <div className="hidden sm:flex items-center">
                <span
                  className={`text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded ${
                    ratingColors[pick.rating] ?? ratingColors.neutral
                  }`}
                >
                  {ratingLabels[pick.rating] ?? pick.rating}
                </span>
              </div>

              {/* Prices */}
              <div className="flex sm:block justify-between sm:text-right">
                <span className="text-xs text-text-light sm:hidden">Entry:</span>
                <span className="text-sm text-text">${pick.priceAtPublish}</span>
              </div>
              <div className="flex sm:block justify-between sm:text-right">
                <span className="text-xs text-text-light sm:hidden">Target:</span>
                <span className="text-sm font-medium text-accent-600">${pick.priceTarget}</span>
              </div>
              <div className="flex sm:block justify-between sm:text-right">
                <span className="text-xs text-text-light sm:hidden">Current:</span>
                <span className="text-sm text-text">
                  {pick.currentPrice ? `$${pick.currentPrice.toFixed(2)}` : "—"}
                </span>
              </div>
              <div className="flex sm:block justify-between sm:text-right">
                <span className="text-xs text-text-light sm:hidden">Return:</span>
                {pick.returnPct !== null ? (
                  <span
                    className={`text-sm font-bold ${
                      pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"
                    }`}
                  >
                    {pick.returnPct >= 0 ? "+" : ""}
                    {pick.returnPct.toFixed(1)}%
                    {pick.hitTarget && (
                      <svg className="inline w-3.5 h-3.5 ml-1 text-accent-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                ) : (
                  <span className="text-sm text-text-light">—</span>
                )}
              </div>
            </Link>
          ))}
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
