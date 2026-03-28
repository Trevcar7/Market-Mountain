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

  // Fetch live prices for picks + SPY benchmark
  const uniqueTickers = [...new Set([...picks.map((p) => p.ticker), "SPY"])];
  const priceMap = new Map<string, number>();

  await Promise.allSettled(
    uniqueTickers.map(async (ticker) => {
      const price = await fetchFmpQuote(ticker);
      if (price) priceMap.set(ticker, price);
    })
  );

  const spyPrice = priceMap.get("SPY");
  const hasLiveData = priceMap.size > 1; // at least 1 pick + SPY

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

  // Portfolio value: $1K per pick
  const investmentPerPick = 1000;
  const totalInvested = enrichedPicks.length * investmentPerPick;
  const portfolioValue = enrichedPicks.reduce((sum, p) => {
    const growth = p.currentPrice ? p.currentPrice / p.priceAtPublish : 1;
    return sum + investmentPerPick * growth;
  }, 0);

  // S&P 500 benchmark: what would $3K in SPY have returned over the avg holding period?
  // Simple approximation: SPY averages ~10% annual return
  const avgHoldingDays = enrichedPicks.length > 0
    ? enrichedPicks.reduce((sum, p) => sum + p.holdingDays, 0) / enrichedPicks.length
    : 0;
  const spyAnnualReturn = 0.10; // ~10% long-term avg
  const spyEstReturn = ((1 + spyAnnualReturn) ** (avgHoldingDays / 365) - 1) * 100;
  const spyPortfolioValue = totalInvested * (1 + spyEstReturn / 100);

  const activePicks = enrichedPicks.filter((p) => p.coverageStatus === "active").length;
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
            Every price target. Every pick. Two metrics per pick: the thesis return (what we predicted)
            and the live return (what the stock is doing now). Full transparency.
          </p>
        </div>
      </section>

      {/* Stats Dashboard */}
      {enrichedPicks.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 -mt-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className="text-2xl font-bold text-text">{enrichedPicks.length}</p>
              <p className="text-xs text-text-muted mt-1">
                Research Picks
                <span className="block text-text-light">
                  {activePicks} active{closedPicks > 0 ? `, ${closedPicks} closed` : ""}
                </span>
              </p>
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
              <p className="text-xs text-text-muted mt-1">Avg Thesis Upside</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5 text-center shadow-sm">
              <p className={`text-2xl font-bold ${avgReturn >= 0 ? "text-accent-600" : "text-red-500"}`}>
                {hasLiveData ? `${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(1)}%` : "—"}
              </p>
              <p className="text-xs text-text-muted mt-1">Avg Live Return</p>
            </div>
          </div>

          {/* S&P 500 Benchmark Comparison */}
          {hasLiveData && (
            <div className="mt-3 bg-card rounded-xl border border-border p-4 sm:p-5 shadow-sm">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-center sm:text-left">
                  <p className="text-[10px] font-bold tracking-widest uppercase text-text-light">
                    Portfolio vs. S&P 500 Benchmark
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    ${totalInvested.toLocaleString()} invested ($1K per pick) over avg {formatHoldingPeriod(Math.round(avgHoldingDays))}
                  </p>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-center">
                    <p className={`text-lg font-bold ${portfolioValue >= totalInvested ? "text-accent-600" : "text-red-500"}`}>
                      ${Math.round(portfolioValue).toLocaleString()}
                    </p>
                    <p className="text-[10px] text-text-muted">Our Picks</p>
                  </div>
                  <div className="text-text-light text-xs">vs</div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-text-muted">
                      ${Math.round(spyPortfolioValue).toLocaleString()}
                    </p>
                    <p className="text-[10px] text-text-muted">S&amp;P 500</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Performance Bars */}
      {hasLiveData && enrichedPicks.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 mt-6">
          <div className="bg-card rounded-xl border border-border shadow-sm p-5 sm:p-6">
            <h2 className="text-sm font-bold tracking-widest uppercase text-text-light mb-4">
              Live Returns by Pick
            </h2>
            <div className="space-y-3">
              {enrichedPicks.map((pick) => {
                const pct = pick.returnPct ?? 0;
                const maxReturn = Math.max(...enrichedPicks.map((p) => Math.abs(p.returnPct ?? 0)), 1);
                const barWidth = Math.min(100, (Math.abs(pct) / maxReturn) * 100);
                return (
                  <div key={pick.ticker} className="flex items-center gap-3">
                    <div className="flex items-center gap-2 w-24 shrink-0">
                      <span className="text-sm font-bold text-text">{pick.ticker}</span>
                      <span className={`text-[9px] font-semibold tracking-wider uppercase px-1 py-0.5 rounded ${statusColors[pick.coverageStatus]}`}>
                        {pick.coverageStatus === "closed" ? "C" : pick.coverageStatus === "target-hit" ? "✓" : "•"}
                      </span>
                    </div>
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
      )}

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
                      <span>{formatHoldingPeriod(pick.holdingDays)} held</span>
                    </div>
                  </div>
                  <p className="text-sm font-medium text-text line-clamp-1">{pick.title}</p>
                  <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{pick.excerpt}</p>
                </div>

                {/* Dual returns: Thesis + Live */}
                <div className="px-5 py-3 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">
                      Thesis Return
                    </p>
                    <p className="text-lg font-bold text-accent-600">
                      +{targetUpside.toFixed(0)}%
                    </p>
                    <p className="text-xs text-text-muted">
                      ${pick.priceAtPublish} → ${pick.priceTarget}
                      {(isTargetHit || isClosed) && <span className="text-accent-600 font-semibold ml-1">achieved</span>}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">
                      Live Return
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
            <strong className="text-text">Thesis Return</strong> represents the upside from entry price to published price target —
            this is the research call as published. <strong className="text-text">Live Return</strong> shows the actual return from
            entry to current market price, updated every 5 minutes. &ldquo;Target Hit&rdquo; is confirmed when the stock reaches
            the price target at any point after publication. &ldquo;Closed&rdquo; means coverage has ended. S&amp;P 500 benchmark
            assumes 10% annualized return over the same holding period. Past performance does not guarantee future results.
          </p>
        </div>
      </section>
    </div>
  );
}
