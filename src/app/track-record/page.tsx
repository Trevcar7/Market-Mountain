import type { Metadata } from "next";
import Link from "next/link";
import { extractPicks } from "@/lib/track-record";
import { fetchFmpQuote, fetchFmpStockHistory } from "@/lib/market-data";

export const revalidate = 86400; // ISR: once per day (closing prices)

export const metadata: Metadata = {
  title: "Track Record",
  description:
    "Transparent performance tracking of all Market Mountain equity research picks — price targets, returns, and win rates.",
};

const statusColors: Record<string, string> = {
  active: "bg-accent-500/15 text-accent-600",
  "target-hit": "bg-accent-500 text-white",
  closed: "bg-surface-2 text-text-muted",
};

const statusLabels: Record<string, string> = {
  active: "Active",
  "target-hit": "Target Hit",
  closed: "Closed",
};

function formatDateShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatHoldingPeriod(days: number): string {
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo`;
  const years = months / 12;
  return years === Math.floor(years) ? `${Math.floor(years)} yr` : `${years.toFixed(1)} yr`;
}

export default async function TrackRecordPage() {
  const picks = extractPicks();

  // Fetch live prices + SPY history in parallel
  const uniqueTickers = [...new Set([...picks.map((p) => p.ticker), "SPY"])];
  const priceMap = new Map<string, number>();
  const oldestPick = picks.reduce((oldest, p) =>
    p.holdingDays > oldest.holdingDays ? p : oldest, picks[0]);

  const [, spyHistoryResult] = await Promise.all([
    // Fetch all quotes in parallel
    Promise.allSettled(
      uniqueTickers.map(async (ticker) => {
        const price = await fetchFmpQuote(ticker);
        if (price) priceMap.set(ticker, price);
      })
    ),
    // Fetch SPY history concurrently (don't wait for quotes first)
    fetchFmpStockHistory("SPY", oldestPick.holdingDays + 30),
  ]);

  const spyPrice = priceMap.get("SPY");
  const hasLiveData = priceMap.size > 1; // at least 1 pick + SPY

  // Enrich with live data
  // For CLOSED picks: use thesis return (entry → target price), not live price
  // For ACTIVE/TARGET-HIT picks: use live return (entry → current price)
  const enrichedPicks = picks.map((pick) => {
    const currentPrice = priceMap.get(pick.ticker);
    const isClosed = pick.coverageStatus === "closed";

    // Closed picks lock in the thesis return; active picks use live
    const returnPct = isClosed
      ? pick.targetReturn ?? null
      : currentPrice
        ? ((currentPrice - pick.priceAtPublish) / pick.priceAtPublish) * 100
        : null;

    const hitTarget = pick.targetHitConfirmed || (currentPrice ? currentPrice >= pick.priceTarget : false);
    return { ...pick, currentPrice: isClosed ? pick.priceTarget : currentPrice, returnPct, hitTarget };
  });

  // Aggregate stats
  const targetHits = enrichedPicks.filter((p) => p.hitTarget);
  const avgTargetUpside =
    enrichedPicks.length > 0
      ? enrichedPicks.reduce((sum, p) => sum + (p.targetReturn ?? 0), 0) / enrichedPicks.length
      : 0;
  const withReturns = enrichedPicks.filter((p) => p.returnPct !== null);
  const avgReturn =
    withReturns.length > 0
      ? withReturns.reduce((sum, p) => sum + (p.returnPct ?? 0), 0) / withReturns.length
      : 0;

  // Portfolio value: maturity-weighted
  // Each pick earns weight through EITHER time held OR magnitude of move:
  //   weight = min(1, max(holdingDays / 60, abs(returnPct) / 15))
  // - New picks with small moves barely count (e.g., day 1, 0% = weight 0.02)
  // - Picks that mature over 60 days reach full weight gradually
  // - Big movers count fully regardless of age (e.g., +400% on day 1 = full weight)
  // - Closed picks always get full weight (thesis completed)
  const MATURITY_DAYS = 60;
  const RETURN_THRESHOLD = 15;
  const investmentPerPick = 1000;

  const pickWeights = enrichedPicks.map((p) => {
    if (p.coverageStatus === "closed") return 1;
    const timeWeight = Math.min(1, p.holdingDays / MATURITY_DAYS);
    const moveWeight = Math.min(1, Math.abs(p.returnPct ?? 0) / RETURN_THRESHOLD);
    return Math.max(timeWeight, moveWeight);
  });
  const totalWeight = pickWeights.reduce((sum, w) => sum + w, 0);
  const totalInvested = totalWeight * investmentPerPick;

  const portfolioValue = enrichedPicks.reduce((sum, p, i) => {
    const invested = pickWeights[i] * investmentPerPick;
    if (p.coverageStatus === "closed") {
      return sum + invested * (p.priceTarget / p.priceAtPublish);
    }
    const growth = p.currentPrice ? p.currentPrice / p.priceAtPublish : 1;
    return sum + invested * growth;
  }, 0);

  // S&P 500 benchmark: simple SPY return from first pick date (Mar 25, 2025) to today
  let spyPortfolioValue = 0;
  let spyDataAvailable = false;

  if (spyPrice && hasLiveData) {
    const spyHistory = spyHistoryResult;

    if (spyHistory && spyHistory.labels.length > 0) {
      const spyPriceMap = new Map<string, number>();
      for (let i = 0; i < spyHistory.labels.length; i++) {
        spyPriceMap.set(spyHistory.labels[i], spyHistory.values[i]);
      }

      function findSpyPrice(targetDate: string): number | null {
        for (let offset = 0; offset <= 5; offset++) {
          const fwd = new Date(new Date(targetDate).getTime() + offset * 86400000).toISOString().split("T")[0];
          const bwd = new Date(new Date(targetDate).getTime() - offset * 86400000).toISOString().split("T")[0];
          if (spyPriceMap.has(fwd)) return spyPriceMap.get(fwd)!;
          if (spyPriceMap.has(bwd)) return spyPriceMap.get(bwd)!;
        }
        return null;
      }

      // SPY return from the oldest pick's entry date to today
      const oldestDate = picks.reduce((oldest, p) =>
        p.date < oldest ? p.date : oldest, picks[0].date);
      const spyStartPrice = findSpyPrice(oldestDate);

      if (spyStartPrice && spyPrice) {
        const spyReturn = (spyPrice - spyStartPrice) / spyStartPrice;
        spyPortfolioValue = totalInvested * (1 + spyReturn);
        spyDataAvailable = true;
      }
    }
  }

  // Fallback: estimate if historical data unavailable
  if (!spyDataAvailable) {
    const oldestPick = picks.reduce((oldest, p) =>
      p.holdingDays > oldest.holdingDays ? p : oldest, picks[0]);
    const spyAnnualReturn = 0.10;
    const spyEstReturn = ((1 + spyAnnualReturn) ** (oldestPick.holdingDays / 365) - 1) * 100;
    spyPortfolioValue = totalInvested * (1 + spyEstReturn / 100);
  }

  const activePicks = enrichedPicks.filter((p) => p.coverageStatus !== "closed").length;
  const closedPicks = enrichedPicks.filter((p) => p.coverageStatus === "closed").length;

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
            Every price target. Every pick. Full transparency — no cherry-picking.
          </p>
        </div>
      </section>

      {/* Stats Dashboard */}
      {enrichedPicks.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 -mt-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-text">{enrichedPicks.length}</p>
              <p className="text-xs text-text-muted mt-1">Picks</p>
            </div>
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
              {(() => {
                const portfolioReturnPct = totalInvested > 0 ? ((portfolioValue - totalInvested) / totalInvested) * 100 : 0;
                return (
                  <>
                    <p className={`text-2xl font-bold ${portfolioReturnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                      {hasLiveData ? `${portfolioReturnPct >= 0 ? "+" : ""}${portfolioReturnPct.toFixed(1)}%` : "—"}
                    </p>
                    <p className="text-xs text-text-muted mt-1">Portfolio Return</p>
                  </>
                );
              })()}
            </div>
          </div>

          {/* S&P 500 Benchmark Comparison */}
          {hasLiveData && (
            <div className="mt-3 bg-card rounded-xl border border-border p-4 sm:p-5 shadow-sm">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-center sm:text-left">
                  <p className="text-[10px] font-bold tracking-widest uppercase text-text-light">
                    Portfolio vs. S&P 500{spyDataAvailable ? "" : " (Est.)"}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    ${(enrichedPicks.length * 1000).toLocaleString()} invested ($1K per pick)
                  </p>
                </div>
                <div className="flex items-center gap-6">
                  {(() => {
                    const displayBase = enrichedPicks.length * 1000;
                    const portfolioReturnPct = totalInvested > 0 ? (portfolioValue - totalInvested) / totalInvested : 0;
                    const portfolioDisplay = displayBase * (1 + portfolioReturnPct);
                    const spyReturnPct = totalInvested > 0 ? (spyPortfolioValue - totalInvested) / totalInvested : 0;
                    const spyDisplay = displayBase * (1 + spyReturnPct);
                    return (
                      <>
                        <div className="text-center">
                          <p className={`text-lg font-bold ${portfolioReturnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                            ${Math.round(portfolioDisplay).toLocaleString()}
                          </p>
                          <p className={`text-[10px] font-semibold ${portfolioReturnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                            {portfolioReturnPct >= 0 ? "+" : ""}{(portfolioReturnPct * 100).toFixed(1)}%
                          </p>
                          <p className="text-[10px] text-text-muted">My Picks</p>
                        </div>
                        <div className="text-text-light text-xs">vs</div>
                        <div className="text-center">
                          <p className="text-lg font-bold text-text-muted">
                            ${Math.round(spyDisplay).toLocaleString()}
                          </p>
                          <p className="text-[10px] font-semibold text-text-muted">
                            {spyReturnPct >= 0 ? "+" : ""}{(spyReturnPct * 100).toFixed(1)}%
                          </p>
                          <p className="text-[10px] text-text-muted">S&amp;P 500</p>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Performance Bars — active picks only */}
      {(() => {
        const activeBars = enrichedPicks.filter((p) => p.coverageStatus !== "closed");
        return hasLiveData && activeBars.length > 0 && (
          <section className="mx-auto max-w-4xl px-4 sm:px-6 mt-6">
            <div className="bg-card rounded-xl border border-border shadow-sm p-5 sm:p-6">
              <h2 className="text-sm font-bold tracking-widest uppercase text-text-light mb-4">
                Active Picks — Current Prices
              </h2>
              <div className="space-y-3">
                {activeBars.map((pick) => {
                  const pct = pick.returnPct ?? 0;
                  const maxReturn = Math.max(...activeBars.map((p) => Math.abs(p.returnPct ?? 0)), 1);
                  const barWidth = Math.min(100, (Math.abs(pct) / maxReturn) * 100);
                  return (
                    <div key={pick.ticker} className="flex items-center gap-3">
                      <span className="text-sm font-bold text-text w-12 shrink-0">{pick.ticker}</span>
                      <div className="flex-1 h-6 bg-surface-2 rounded-full overflow-hidden">
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
        );
      })()}

      {/* All Research Picks */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 py-10 sm:py-14">
        <h2 className="text-lg font-serif font-bold text-text mb-6">
          All Research Picks
        </h2>

        <div className="space-y-4">
          {enrichedPicks.map((pick) => {
            const targetUpside = pick.targetReturn ?? 0;
            const isClosed = pick.coverageStatus === "closed";
            const isTargetHit = pick.coverageStatus === "target-hit" || pick.hitTarget;

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
                    <span className={`text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded ${statusColors[pick.coverageStatus]}`}>
                      {statusLabels[pick.coverageStatus]}
                    </span>
                    {pick.tags[0] && (
                      <span className="text-[10px] font-medium tracking-wider uppercase text-text-light px-1.5 py-0.5 rounded bg-surface-2">
                        {pick.tags[0]}
                      </span>
                    )}
                    <div className="flex items-center gap-2 ml-auto text-[11px] text-text-light">
                      <span>{formatDateShort(pick.date)}</span>
                      <span className="text-border">|</span>
                      <span>
                        {pick.targetHitDate && (pick.targetHitConfirmed || pick.coverageStatus === "closed")
                          ? `${formatHoldingPeriod(Math.floor((new Date(pick.targetHitDate).getTime() - new Date(pick.date).getTime()) / 86400000))} to target`
                          : `${formatHoldingPeriod(pick.holdingDays)} held`}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm font-medium text-text line-clamp-1">{pick.title}</p>
                  <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{pick.excerpt}</p>
                </div>

                {/* Dual returns: Thesis + Live */}
                <div className="px-5 py-3 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">
                      Price Target
                    </p>
                    <p className="text-lg font-bold text-accent-600">
                      +{targetUpside.toFixed(0)}%
                    </p>
                    <p className="text-xs text-text-muted">
                      ${pick.priceAtPublish} → ${pick.priceTarget}
                      {(isTargetHit || isClosed) && <span className="text-accent-600 font-semibold ml-1">achieved</span>}
                    </p>
                  </div>
                  {!isClosed && (
                  <div>
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">
                      Current Price
                    </p>
                    {pick.returnPct !== null ? (
                      <>
                        <p className={`text-lg font-bold ${pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                          {pick.returnPct >= 0 ? "+" : ""}{pick.returnPct.toFixed(1)}%
                        </p>
                        <p className="text-xs text-text-muted">
                          ${pick.priceAtPublish} → ${pick.currentPrice?.toFixed(2)} now
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-lg font-bold text-text-light">—</p>
                        <p className="text-xs text-text-muted">Live data unavailable</p>
                      </>
                    )}
                  </div>
                  )}
                </div>

                {/* Progress bar */}
                <div className="px-5 pb-3">
                  {(isTargetHit || isClosed) ? (
                    <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-accent-500 w-full" />
                    </div>
                  ) : (
                    <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          (pick.returnPct ?? 0) > 0 ? "bg-accent-400" : "bg-red-400"
                        }`}
                        style={{
                          width: `${Math.max(2, Math.min(100, targetUpside > 0 && pick.returnPct
                            ? (pick.returnPct / targetUpside) * 100
                            : 0))}%`
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* Coverage note for closed picks */}
                {pick.coverageNote && (
                  <div className="px-5 pb-4">
                    <p className="text-[11px] text-text-light italic">{pick.coverageNote}</p>
                  </div>
                )}
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
            Entry prices are the closing price on publication date. <strong className="text-text">Price Target</strong> is the
            published valuation target. <strong className="text-text">Current Price</strong> updates daily using closing prices.
            Closed picks lock in the return at the price target. The S&amp;P 500 benchmark uses actual SPY prices
            over each pick&apos;s holding period. Past performance does not guarantee future results.
          </p>
        </div>
      </section>
    </div>
  );
}
