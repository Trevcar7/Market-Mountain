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
  buy: "bg-accent-500/15 text-accent-600",
  hold: "bg-amber-500/15 text-amber-600",
  sell: "bg-red-500/15 text-red-500",
  watchlist: "bg-navy-500/15 text-navy-300",
  neutral: "bg-surface-2 text-text-muted",
};

const ratingLabels: Record<string, string> = {
  buy: "Buy",
  hold: "Hold",
  sell: "Sell",
  watchlist: "Watchlist",
  neutral: "Neutral",
};

function formatDateShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatHoldingPeriod(days: number): string {
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${(months / 12).toFixed(1)}yr`;
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
  const avgTargetUpside =
    enrichedPicks.length > 0
      ? enrichedPicks.reduce((sum, p) => sum + (p.targetReturn ?? 0), 0) / enrichedPicks.length
      : 0;

  // Cumulative return: $1K per pick portfolio
  const investmentPerPick = 1000;
  const totalInvested = enrichedPicks.length * investmentPerPick;
  const cumulativeValue = enrichedPicks.reduce((sum, p) => {
    const growth = p.currentPrice ? p.currentPrice / p.priceAtPublish : 1;
    return sum + investmentPerPick * growth;
  }, 0);
  const cumulativeReturnPct = totalInvested > 0
    ? ((cumulativeValue - totalInvested) / totalInvested) * 100
    : 0;
  const hasLiveData = priceMap.size > 0;

  // Best performer
  const bestPick = enrichedPicks.reduce((best, p) =>
    (p.returnPct ?? 0) > (best.returnPct ?? 0) ? p : best
  , enrichedPicks[0]);

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

      {/* Stats Dashboard */}
      {enrichedPicks.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 -mt-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-accent-600">
                {targetHits.length}/{enrichedPicks.length}
              </p>
              <p className="text-xs text-text-muted mt-1">Price Targets Hit</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-accent-600">
                +{avgTargetUpside.toFixed(0)}%
              </p>
              <p className="text-xs text-text-muted mt-1">Avg Target Upside</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className={`text-2xl font-bold ${avgReturn >= 0 ? "text-accent-600" : "text-red-500"}`}>
                {hasLiveData ? `${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(1)}%` : "—"}
              </p>
              <p className="text-xs text-text-muted mt-1">Avg Current Return</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              {hasLiveData ? (
                <>
                  <p className={`text-2xl font-bold ${cumulativeReturnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                    ${Math.round(cumulativeValue).toLocaleString()}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    ${totalInvested.toLocaleString()} invested → today
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold text-text-light">—</p>
                  <p className="text-xs text-text-muted mt-1">$1K/pick value today</p>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Performance Overview */}
      {hasLiveData && enrichedPicks.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 mt-8">
          <div className="bg-card rounded-xl border border-border shadow-sm p-5 sm:p-6">
            <h2 className="text-sm font-bold tracking-widest uppercase text-text-light mb-4">
              Performance by Pick
            </h2>
            <div className="space-y-3">
              {enrichedPicks.map((pick) => {
                const pct = pick.returnPct ?? 0;
                const maxReturn = Math.max(...enrichedPicks.map((p) => Math.abs(p.returnPct ?? 0)), 1);
                const barWidth = Math.min(100, (Math.abs(pct) / maxReturn) * 100);
                return (
                  <div key={pick.ticker} className="flex items-center gap-3">
                    <span className="text-sm font-bold text-text w-12 shrink-0">{pick.ticker}</span>
                    <div className="flex-1 h-6 bg-surface-2 rounded-full overflow-hidden relative">
                      <div
                        className={`h-full rounded-full transition-all ${pct >= 0 ? "bg-accent-500" : "bg-red-500"}`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                    <span className={`text-sm font-bold w-16 text-right shrink-0 ${pct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                      {pick.returnPct !== null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* All Research Picks */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 py-10 sm:py-14">
        <h2 className="text-lg font-serif font-bold text-text mb-6">
          All Research Picks
        </h2>

        <div className="space-y-4">
          {enrichedPicks.map((pick) => {
            const targetUpside = pick.targetReturn ?? 0;
            const progressToTarget = pick.returnPct !== null && targetUpside > 0
              ? Math.min(150, (pick.returnPct / targetUpside) * 100)
              : 0;

            return (
              <Link
                key={`${pick.ticker}-${pick.date}`}
                href={`/post/${pick.slug}`}
                className="block bg-card rounded-xl border border-border shadow-sm hover:border-accent-300 hover:shadow-md transition-all overflow-hidden"
              >
                {/* Card header */}
                <div className="px-5 pt-5 pb-2">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-lg font-bold text-text">{pick.ticker}</span>
                    <span
                      className={`text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded ${
                        ratingColors[pick.rating] ?? ratingColors.neutral
                      }`}
                    >
                      {ratingLabels[pick.rating] ?? pick.rating}
                    </span>
                    {pick.tags[0] && (
                      <span className="text-[10px] font-medium tracking-wider uppercase text-text-light px-1.5 py-0.5 rounded bg-surface-2">
                        {pick.tags[0]}
                      </span>
                    )}
                    {pick.hitTarget && (
                      <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-accent-500 text-white flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        TARGET HIT
                      </span>
                    )}
                    <div className="flex items-center gap-2 ml-auto text-[11px] text-text-light">
                      <span>{formatDateShort(pick.date)}</span>
                      <span className="text-border">|</span>
                      <span>{formatHoldingPeriod(pick.holdingDays)} held</span>
                    </div>
                  </div>
                  <p className="text-sm font-medium text-text line-clamp-1">{pick.title}</p>
                  <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{pick.excerpt}</p>
                </div>

                {/* Progress to target bar */}
                <div className="px-5 pb-3 pt-2">
                  {pick.hitTarget ? (
                    <>
                      {/* Target was hit — show full bar with success message */}
                      <div className="flex items-center justify-between text-[10px] text-text-light mb-1">
                        <span>Entry ${pick.priceAtPublish}</span>
                        {pick.currentPrice && (
                          <span className="font-medium text-text">
                            Now ${pick.currentPrice.toFixed(2)}
                          </span>
                        )}
                        <span className="font-semibold text-accent-600">Target ${pick.priceTarget} reached</span>
                      </div>
                      <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-accent-500 w-full" />
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-[10px] font-semibold text-accent-600">
                          +{targetUpside.toFixed(0)}% target upside — achieved
                        </span>
                        {pick.returnPct !== null && (
                          <span className={`text-[10px] font-semibold ${pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                            {pick.returnPct >= 0 ? "+" : ""}{pick.returnPct.toFixed(1)}% current return
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Target not yet hit — show progress */}
                      <div className="flex items-center justify-between text-[10px] text-text-light mb-1">
                        <span>Entry ${pick.priceAtPublish}</span>
                        {pick.currentPrice && (
                          <span className="font-medium text-text">
                            Current ${pick.currentPrice.toFixed(2)}
                          </span>
                        )}
                        <span>Target ${pick.priceTarget}</span>
                      </div>
                      <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            progressToTarget > 0 ? "bg-accent-400" : "bg-red-400"
                          }`}
                          style={{ width: `${Math.max(2, Math.min(100, progressToTarget))}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-[10px] text-text-light">
                          +{targetUpside.toFixed(0)}% target upside
                        </span>
                        {pick.returnPct !== null && (
                          <span className={`text-[10px] font-semibold ${pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                            {pick.returnPct >= 0 ? "+" : ""}{pick.returnPct.toFixed(1)}% current return
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Price data grid */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-border">
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Entry</p>
                    <p className="text-base font-bold text-text">${pick.priceAtPublish}</p>
                  </div>
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Target</p>
                    <p className="text-base font-bold text-accent-600">${pick.priceTarget}</p>
                  </div>
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Current</p>
                    <p className="text-base font-bold text-text">
                      {pick.currentPrice ? `$${pick.currentPrice.toFixed(2)}` : "—"}
                    </p>
                  </div>
                  <div className="bg-card px-4 py-3">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Return</p>
                    {pick.returnPct !== null ? (
                      <p className={`text-base font-bold ${pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                        {pick.returnPct >= 0 ? "+" : ""}{pick.returnPct.toFixed(1)}%
                      </p>
                    ) : (
                      <p className="text-base text-text-light">—</p>
                    )}
                  </div>
                  <div className="bg-card px-4 py-3 col-span-2 sm:col-span-1">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">Status</p>
                    {pick.hitTarget ? (
                      <span className="text-sm font-semibold text-accent-600">Target Reached</span>
                    ) : pick.returnPct !== null && pick.returnPct > 0 ? (
                      <span className="text-sm font-medium text-accent-600">In Profit</span>
                    ) : pick.returnPct !== null ? (
                      <span className="text-sm font-medium text-amber-600">Active</span>
                    ) : (
                      <span className="text-sm text-text-light">Tracking</span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* Methodology */}
        <div className="mt-10 p-5 sm:p-6 rounded-xl bg-surface-2 border border-border">
          <h3 className="text-xs font-bold tracking-widest uppercase text-text-light mb-3">
            How We Track Performance
          </h3>
          <p className="text-xs text-text-muted leading-relaxed">
            Entry prices are recorded at closing price on publication date. Price targets reflect
            our DCF and multi-model valuation at the time of initiating coverage. &ldquo;Target Hit&rdquo; is
            confirmed when the stock reaches the price target at any point after publication.
            Current prices update every 5 minutes via live market data. Returns are calculated
            from entry price to current market price. Past performance does not guarantee future
            results. All investment research is for informational purposes only and does not
            constitute financial advice.
          </p>
        </div>
      </section>
    </div>
  );
}
