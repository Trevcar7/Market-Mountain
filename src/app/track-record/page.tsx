import type { Metadata } from "next";
import Link from "next/link";
import { extractPicks } from "@/lib/track-record";
import { fetchFmpQuote, fetchFmpStockHistory } from "@/lib/market-data";

export const revalidate = 14400; // ISR: every 4 hours (~2-3 updates during market hours)

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
  // Parse YYYY-MM-DD as local date (not UTC) so display doesn't timezone-shift
  const [y, m, d] = dateStr.split("-").map(Number);
  const local = new Date(y, m - 1, d);
  return local.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
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

  // Fetch live prices + SPY history in parallel.
  // Closed picks use thesis target price, so skip their live quotes — keeps the
  // request count under AlphaVantage's free-tier 5/min cap.
  const uniqueTickers = [...new Set([
    ...picks.filter((p) => p.coverageStatus !== "closed").map((p) => p.ticker),
    "SPY",
  ])];
  const priceMap = new Map<string, number>();
  const oldestPick = picks.reduce((oldest, p) =>
    p.holdingDays > oldest.holdingDays ? p : oldest, picks[0]);

  const [, spyHistoryResult] = await Promise.all([
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

  // Portfolio value: $1K per pick, equal-weight
  // Picks held < 30 days are excluded so new holdings don't drag down the average.
  // Once a pick passes 30 days (or hits ±15% move), it's included at full weight.
  // When a closed pick hits its target, proceeds are reinvested equally into
  // active picks still below their price targets — at the price on the closed
  // pick's target-hit date, NOT the active pick's original entry price.
  const MIN_DAYS = 30;
  const MOVE_THRESHOLD = 15;
  const investmentPerPick = 1000;

  const qualifiedPicks = enrichedPicks.filter((p) =>
    p.coverageStatus === "closed" ||
    p.holdingDays >= MIN_DAYS ||
    Math.abs(p.returnPct ?? 0) >= MOVE_THRESHOLD
  );
  const qualifiedTickers = new Set(qualifiedPicks.map((p) => p.ticker));
  const totalInvested = qualifiedPicks.length * investmentPerPick;

  // Reinvestment: closed-pick proceeds AND partial-sale proceeds are both
  // redistributed into active picks below target.
  const closedPicksForReinvest = qualifiedPicks.filter(
    (p) => p.coverageStatus === "closed" && p.targetHitDate
  );
  const picksWithPartialSale = qualifiedPicks.filter(
    (p) => p.partialSale && p.coverageStatus !== "closed"
  );
  // Reinvest recipients = every pick whose coverage hasn't been closed.
  // Hit-target picks remain in the portfolio (coverage continues), so they
  // can still receive proceeds from a closed pick's distribution.
  const reinvestTargets = enrichedPicks.filter(
    (p) => p.coverageStatus !== "closed"
  );

  // A pick is "live" (part of the portfolio) on a given date when it had
  // already been published AND its coverage hadn't closed yet. Closed
  // picks exit the portfolio on `targetHitDate`; everything else is live
  // from its publish date onward.
  const isLiveAt = (p: typeof enrichedPicks[number], date: string) => {
    if (p.date > date) return false;
    if (p.coverageStatus === "closed" && p.targetHitDate && p.targetHitDate <= date) {
      return false;
    }
    return true;
  };

  // Fetch each active reinvest target's historical price covering all close
  // dates AND partial-sale dates, so reinvested capital can buy in at the
  // event-date price.
  const activePriceOnEventDate = new Map<string, Map<string, number>>(); // ticker → event-date → price
  const reinvestEventDates = [
    ...closedPicksForReinvest.map((p) => p.targetHitDate!),
    ...picksWithPartialSale.map((p) => p.partialSale!.date),
  ];
  if (reinvestEventDates.length > 0 && reinvestTargets.length > 0) {
    const oldestEventDate = reinvestEventDates.reduce(
      (oldest, d) => (d < oldest ? d : oldest),
      reinvestEventDates[0]
    );
    const daysBack =
      Math.floor((Date.now() - new Date(oldestEventDate).getTime()) / 86400000) + 30;

    await Promise.allSettled(
      reinvestTargets.map(async (rt) => {
        const hist = await fetchFmpStockHistory(rt.ticker, daysBack);
        if (!hist || hist.labels.length === 0) return;
        const dateMap = new Map<string, number>();
        for (let i = 0; i < hist.labels.length; i++) {
          dateMap.set(hist.labels[i], hist.values[i]);
        }
        const lookupMap = new Map<string, number>();
        for (const target of reinvestEventDates) {
          // find nearest market day within ±5 days
          for (let off = 0; off <= 5; off++) {
            const fwd = new Date(new Date(target).getTime() + off * 86400000)
              .toISOString().split("T")[0];
            const bwd = new Date(new Date(target).getTime() - off * 86400000)
              .toISOString().split("T")[0];
            if (dateMap.has(fwd)) { lookupMap.set(target, dateMap.get(fwd)!); break; }
            if (dateMap.has(bwd)) { lookupMap.set(target, dateMap.get(bwd)!); break; }
          }
        }
        activePriceOnEventDate.set(rt.ticker, lookupMap);
      })
    );
  }

  // Recipients for a reinvest event: every reinvest target that was live
  // on the event date (published and not yet closed), excluding the
  // selling/closing pick itself. This is the chronologically honest
  // model — proceeds flow to picks that actually existed at the time,
  // not to today's roster retroactively.
  const eligibleRecipientsForDate = (
    eventDate: string,
    opts: { excludeTicker?: string } = {}
  ) => {
    return reinvestTargets.filter((rt) => {
      if (rt.ticker === opts.excludeTicker) return false;
      return isLiveAt(rt, eventDate);
    });
  };

  const closedPickProceedsList = closedPicksForReinvest.map((cp) => {
    const eligible = eligibleRecipientsForDate(cp.targetHitDate!, { excludeTicker: cp.ticker });
    const proceeds = investmentPerPick * (cp.priceTarget / cp.priceAtPublish);
    return {
      pick: cp,
      eventDate: cp.targetHitDate!,
      proceeds,
      eligible,
      slicePerEligible: eligible.length > 0 ? proceeds / eligible.length : 0,
    };
  });
  const totalClosedProceeds = closedPickProceedsList.reduce((s, c) => s + c.proceeds, 0);

  // Buy-in price for a reinvest recipient on a given event date.
  // - If the recipient was published on/after the event date, the slice
  //   waits in cash until the pick is published and is bought at its
  //   `priceAtPublish` (the canonical entry price for that pick).
  // - Otherwise use the recipient's market price on the event date,
  //   falling back to today's live price for events within the last
  //   ~7 days (FMP daily history often lags a trading day).
  const pickByTicker = new Map(enrichedPicks.map((p) => [p.ticker, p]));
  const todayIso = new Date().toISOString().split("T")[0];
  const buyInPrice = (ticker: string, eventDate: string): number | undefined => {
    const p = pickByTicker.get(ticker);
    if (p && p.date >= eventDate) return p.priceAtPublish;
    const fromHistory = activePriceOnEventDate.get(ticker)?.get(eventDate);
    if (fromHistory) return fromHistory;
    // FMP historical can be flaky; fall back to today's live price so the
    // page renders. Approximate when events are old, accurate when recent.
    return priceMap.get(ticker);
  };

  // Helper: seller's positionShares right before the partial sale (initial $1K
  // plus any closed-pick reinvest slices into this seller, if eligible).
  const sellerSharesBeforeSale = (sellerTicker: string, sellerPriceAtPublish: number) => {
    let shares = investmentPerPick / sellerPriceAtPublish;
    for (const { eventDate, slicePerEligible, eligible } of closedPickProceedsList) {
      if (!eligible.some((e) => e.ticker === sellerTicker)) continue;
      const pxAtClose = buyInPrice(sellerTicker, eventDate);
      if (!pxAtClose) continue;
      shares += slicePerEligible / pxAtClose;
    }
    return shares;
  };

  // Partial-sale proceeds: sellerShares × fraction × salePrice. Recipients =
  // reinvest targets (excluding the seller) with a price on the sale date.
  const partialSaleProceedsList = picksWithPartialSale.map((sp) => {
    const ps = sp.partialSale!;
    const f = Math.max(0, Math.min(1, ps.fraction));
    const sellerShares = sellerSharesBeforeSale(sp.ticker, sp.priceAtPublish);
    const proceeds = sellerShares * f * ps.salePrice;
    const eligible = eligibleRecipientsForDate(ps.date, { excludeTicker: sp.ticker });
    return {
      pick: sp,
      eventDate: ps.date,
      fraction: f,
      salePrice: ps.salePrice,
      sellerShares,
      proceeds,
      eligible,
      slicePerEligible: eligible.length > 0 ? proceeds / eligible.length : 0,
    };
  });

  // Compute today's value of all reinvested slices (closed + partial-sale) for
  // a given active pick. Each slice grows from its event-date price → today's price.
  const reinvestValueForActive = (activeTicker: string): number => {
    const currentPrice = priceMap.get(activeTicker);
    if (!currentPrice) return 0;
    let total = 0;
    for (const { eventDate, slicePerEligible, eligible } of closedPickProceedsList) {
      if (!eligible.some((e) => e.ticker === activeTicker)) continue;
      const pxAtEvent = buyInPrice(activeTicker, eventDate);
      if (!pxAtEvent) continue;
      total += slicePerEligible * (currentPrice / pxAtEvent);
    }
    for (const ev of partialSaleProceedsList) {
      if (ev.pick.ticker === activeTicker) continue;
      if (!ev.eligible.some((e) => e.ticker === activeTicker)) continue;
      const pxAtEvent = buyInPrice(activeTicker, ev.eventDate);
      if (!pxAtEvent) continue;
      total += ev.slicePerEligible * (currentPrice / pxAtEvent);
    }
    return total;
  };

  const portfolioValue = enrichedPicks.reduce((sum, p) => {
    if (p.coverageStatus === "closed") {
      // Proceeds redistributed — this pick contributes $0 directly
      return sum;
    }
    // Partial sale: seller contributes only the un-sold fraction at live price;
    // sold proceeds were redeployed into other picks via reinvestValueForActive.
    if (p.partialSale && p.currentPrice) {
      const f = Math.max(0, Math.min(1, p.partialSale.fraction));
      const sellerShares = sellerSharesBeforeSale(p.ticker, p.priceAtPublish);
      return sum + sellerShares * (1 - f) * p.currentPrice;
    }
    const isQualified = qualifiedTickers.has(p.ticker);
    const baseGrowth = p.currentPrice ? p.currentPrice / p.priceAtPublish : 1;
    // Unqualified picks (< 30 days, no big move) don't yet contribute their
    // baseline $1K — but they DO contribute any reinvest slice they received.
    const baseValue = isQualified ? investmentPerPick * baseGrowth : 0;
    // Hit-target picks remain in the portfolio (coverage continues), so they
    // can still hold reinvest slices from a closed pick's distribution. The
    // eligibility list inside reinvestValueForActive already excludes the
    // wrong recipients, so always compute it here.
    const reinvestValue = reinvestValueForActive(p.ticker);
    return sum + baseValue + reinvestValue;
  }, 0);

  // S&P 500 benchmark: dollar-cost-averaged into SPY. Each qualified pick's
  // $1K is invested in SPY at that pick's publish date and held to today.
  // This is the apples-to-apples comparison — what if I had bought SPY
  // instead of each stock on the day I published the thesis.
  let spyPortfolioValue = 0;
  let spyReturnPct = 0;
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

      let spyTotal = 0;
      let allFound = true;
      for (const p of qualifiedPicks) {
        const startPx = findSpyPrice(p.date);
        if (!startPx) { allFound = false; break; }
        spyTotal += investmentPerPick * (spyPrice / startPx);
      }

      if (allFound && qualifiedPicks.length > 0) {
        spyPortfolioValue = spyTotal;
        spyReturnPct = ((spyTotal - totalInvested) / totalInvested) * 100;
        spyDataAvailable = true;
      }
    }
  }

  if (!spyDataAvailable) {
    // Fallback: 10% annualized estimate, weighted by each pick's holding period
    let spyEstTotal = 0;
    for (const p of qualifiedPicks) {
      spyEstTotal += investmentPerPick * (1 + 0.10) ** (p.holdingDays / 365);
    }
    spyPortfolioValue = spyEstTotal;
    spyReturnPct = totalInvested > 0 ? ((spyEstTotal - totalInvested) / totalInvested) * 100 : 0;
  }

  const activePicks = enrichedPicks.filter((p) => p.coverageStatus !== "closed").length;
  const closedPicks = enrichedPicks.filter((p) => p.coverageStatus === "closed").length;

  return (
    <div className="min-h-screen bg-surface">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-10 sm:py-20">
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
          <div className="grid grid-cols-3 gap-3">
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
                    Portfolio vs. S&amp;P 500{spyDataAvailable ? "" : " (Est.)"}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    ${totalInvested.toLocaleString()} invested ($1K per pick{qualifiedPicks.length < enrichedPicks.length ? `, ${enrichedPicks.length - qualifiedPicks.length} maturing` : ""}{(totalClosedProceeds > 0 || partialSaleProceedsList.length > 0) && reinvestTargets.length > 0 ? ` · proceeds reinvested at event-date prices` : ""})
                  </p>
                </div>
                <div className="flex items-center gap-6">
                  {(() => {
                    const portfolioReturnPct = totalInvested > 0 ? (portfolioValue - totalInvested) / totalInvested : 0;
                    const portfolioDisplay = totalInvested * (1 + portfolioReturnPct);
                    const spyReturnFrac = totalInvested > 0 ? (spyPortfolioValue - totalInvested) / totalInvested : 0;
                    const spyDisplay = totalInvested * (1 + spyReturnFrac);
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
                            {spyReturnFrac >= 0 ? "+" : ""}{(spyReturnFrac * 100).toFixed(1)}%
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

      {/* Reinvestment Flow — closed-pick and partial-sale proceeds */}
      {(closedPickProceedsList.length > 0 || partialSaleProceedsList.length > 0) && reinvestTargets.length > 0 && (
        <section className="mx-auto max-w-4xl px-4 sm:px-6 mt-6">
          <div className="bg-card rounded-xl border border-border shadow-sm p-5 sm:p-6">
            <h2 className="text-sm font-bold tracking-widest uppercase text-text-light mb-4">
              Reinvestment Flow
            </h2>
            <div className="space-y-4">
              {closedPickProceedsList.map(({ pick: cp, proceeds, eligible, slicePerEligible }) => (
                <div key={`closed-${cp.ticker}`} className="border-l-2 border-accent-500 pl-4">
                  <p className="text-sm font-semibold text-text">
                    {cp.ticker} closed {formatDateShort(cp.targetHitDate!)}
                    <span className="text-text-muted font-normal"> — ${cp.priceAtPublish} → ${cp.priceTarget} ({(((cp.priceTarget - cp.priceAtPublish) / cp.priceAtPublish) * 100).toFixed(0)}%)</span>
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    $1,000 grew to <strong className="text-text">${formatMoney(proceeds)}</strong>,
                    split into {eligible.length} active pick{eligible.length === 1 ? "" : "s"} =
                    <strong className="text-text"> +${formatMoney(slicePerEligible)} each</strong>
                  </p>
                  <div className="mt-2 text-xs text-text-muted">
                    <span className="font-semibold text-text-light">Reinvested into:</span>{" "}
                    {eligible.map((rt, i) => {
                      const pxAtClose = buyInPrice(rt.ticker, cp.targetHitDate!);
                      return (
                        <span key={rt.ticker}>
                          <span className="font-semibold text-text">{rt.ticker}</span>
                          <span> @ {pxAtClose ? `$${pxAtClose.toFixed(2)}` : "—"}</span>
                          {i < eligible.length - 1 ? <span>, </span> : null}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
              {partialSaleProceedsList.map((ev) => {
                const fracLabel = ev.fraction === 0.5 ? "half" : `${Math.round(ev.fraction * 100)}%`;
                return (
                  <div key={`partial-${ev.pick.ticker}`} className="border-l-2 border-accent-400 pl-4">
                    <p className="text-sm font-semibold text-text">
                      {ev.pick.ticker} sold {fracLabel} {formatDateShort(ev.eventDate)}
                      <span className="text-text-muted font-normal"> — ${ev.pick.priceAtPublish} entry → ${ev.salePrice.toFixed(2)} sale ({(((ev.salePrice - ev.pick.priceAtPublish) / ev.pick.priceAtPublish) * 100).toFixed(0)}%)</span>
                    </p>
                    <p className="text-xs text-text-muted mt-1">
                      <strong className="text-text">${formatMoney(ev.proceeds)}</strong> realized,
                      split into {ev.eligible.length} active pick{ev.eligible.length === 1 ? "" : "s"} =
                      <strong className="text-text"> +${formatMoney(ev.slicePerEligible)} each</strong>
                    </p>
                    {ev.eligible.length > 0 && (
                      <div className="mt-2 text-xs text-text-muted">
                        <span className="font-semibold text-text-light">Reinvested into:</span>{" "}
                        {ev.eligible.map((rt, i) => {
                          const pxAtEvent = buyInPrice(rt.ticker, ev.eventDate);
                          return (
                            <span key={rt.ticker}>
                              <span className="font-semibold text-text">{rt.ticker}</span>
                              <span> @ {pxAtEvent ? `$${pxAtEvent.toFixed(2)}` : "—"}</span>
                              {i < ev.eligible.length - 1 ? <span>, </span> : null}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Performance Bars — active picks only */}
      {(() => {
        const activeBars = enrichedPicks.filter((p) => p.coverageStatus !== "closed");
        return hasLiveData && activeBars.length > 0 && (
          <section className="mx-auto max-w-4xl px-4 sm:px-6 mt-6">
            <div className="bg-card rounded-xl border border-border shadow-sm p-5 sm:p-6">
              <h2 className="text-sm font-bold tracking-widest uppercase text-text-light mb-4">
                Active Picks — Return Since Publish
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
      <section className="mx-auto max-w-4xl px-4 sm:px-6 py-7 sm:py-14">
        <h2 className="text-lg font-serif font-bold text-text mb-6">
          All Research Picks
        </h2>

        <div className="space-y-4">
          {enrichedPicks.map((pick) => {
            const targetUpside = pick.targetReturn ?? 0;
            const isClosed = pick.coverageStatus === "closed";
            const isTargetHit = pick.coverageStatus === "target-hit" || pick.hitTarget;

            // Hypothetical position size + FIFO cost basis (Robinhood default).
            // Build chronological lots: initial $1K buy at entry, plus any
            // reinvest slice this pick received (at the event-date price).
            // On a partial sale, consume the earliest lots first.
            const isReinvestRecipient = reinvestTargets.some((rt) => rt.ticker === pick.ticker);
            const isQualified = qualifiedTickers.has(pick.ticker);
            const lots: { date: string; shares: number; costPerShare: number }[] = [
              { date: pick.date, shares: investmentPerPick / pick.priceAtPublish, costPerShare: pick.priceAtPublish },
            ];
            if (isReinvestRecipient) {
              for (const { eventDate, slicePerEligible, eligible } of closedPickProceedsList) {
                if (!eligible.some((e) => e.ticker === pick.ticker)) continue;
                const pxAtEvent = buyInPrice(pick.ticker, eventDate);
                if (!pxAtEvent) continue;
                lots.push({ date: eventDate, shares: slicePerEligible / pxAtEvent, costPerShare: pxAtEvent });
              }
              for (const ev of partialSaleProceedsList) {
                if (ev.pick.ticker === pick.ticker) continue;
                if (!ev.eligible.some((e) => e.ticker === pick.ticker)) continue;
                const pxAtEvent = buyInPrice(pick.ticker, ev.eventDate);
                if (!pxAtEvent) continue;
                lots.push({ date: ev.eventDate, shares: ev.slicePerEligible / pxAtEvent, costPerShare: pxAtEvent });
              }
              lots.sort((a, b) => a.date.localeCompare(b.date));
            }
            // FIFO partial sale: drain earliest lots first.
            if (pick.partialSale) {
              const f = Math.max(0, Math.min(1, pick.partialSale.fraction));
              let toSell = lots.reduce((s, l) => s + l.shares, 0) * f;
              for (const lot of lots) {
                if (toSell <= 0) break;
                const sellFromLot = Math.min(lot.shares, toSell);
                lot.shares -= sellFromLot;
                toSell -= sellFromLot;
              }
            }
            const positionShares = lots.reduce((s, l) => s + l.shares, 0);
            const positionInvested = lots.reduce((s, l) => s + l.shares * l.costPerShare, 0);
            const avgCost = positionShares > 0 ? positionInvested / positionShares : pick.priceAtPublish;

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

                {/* Returns: Target + Thesis-since-publish + Position (avg-cost) when they differ */}
                {(() => {
                  const hasReinvestLot = Math.abs(avgCost - pick.priceAtPublish) >= 0.01;
                  const positionReturnPct = pick.currentPrice && avgCost > 0
                    ? ((pick.currentPrice - avgCost) / avgCost) * 100
                    : null;
                  const showPositionCol = !isClosed && hasReinvestLot && positionReturnPct !== null;
                  return (
                <div className={`px-5 py-3 grid gap-4 ${showPositionCol ? "grid-cols-3" : "grid-cols-2"}`}>
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
                      Since Publish
                    </p>
                    {pick.returnPct !== null ? (
                      <>
                        <p className={`text-lg font-bold ${pick.returnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                          {pick.returnPct >= 0 ? "+" : ""}{pick.returnPct.toFixed(1)}%
                        </p>
                        <p className="text-xs text-text-muted">
                          ${pick.priceAtPublish} → ${pick.currentPrice?.toFixed(2)}
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
                  {showPositionCol && positionReturnPct !== null && (
                  <div>
                    <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-1">
                      Position (avg cost)
                    </p>
                    <p className={`text-lg font-bold ${positionReturnPct >= 0 ? "text-accent-600" : "text-red-500"}`}>
                      {positionReturnPct >= 0 ? "+" : ""}{positionReturnPct.toFixed(1)}%
                    </p>
                    <p className="text-xs text-text-muted">
                      ${avgCost.toFixed(2)} → ${pick.currentPrice?.toFixed(2)}
                    </p>
                  </div>
                  )}
                </div>
                  );
                })()}

                {/* Hypothetical position note */}
                {!isClosed && (
                  <div className="px-5 -mt-1 mb-2">
                    <p className="text-[11px] text-text-light">
                      Hypothetical position:{" "}
                      <span className="font-semibold text-text-muted">${formatMoney(positionInvested)}</span>
                      {" "}invested · avg cost{" "}
                      <span className="font-semibold text-text-muted">${avgCost.toFixed(2)}/share</span>
                      {!isQualified && <span className="text-text-light"> · maturing</span>}
                    </p>
                    {pick.partialSale && (() => {
                      const f = Math.max(0, Math.min(1, pick.partialSale.fraction));
                      const fracLabel = f === 0.5 ? "half" : `${Math.round(f * 100)}%`;
                      const event = partialSaleProceedsList.find((ev) => ev.pick.ticker === pick.ticker);
                      const recipients = event?.eligible.map((e) => e.ticker).join(", ");
                      return (
                        <p className="text-[11px] text-text-light mt-1">
                          Sold {fracLabel} at{" "}
                          <span className="font-semibold text-text-muted">${pick.partialSale.salePrice.toFixed(2)}</span>
                          {" "}on {formatDateShort(pick.partialSale.date)}
                          {event && event.proceeds > 0 && (
                            <>
                              {" "}·{" "}
                              <span className="font-semibold text-text-muted">${formatMoney(event.proceeds)}</span>
                              {" "}reinvested
                              {recipients && <span> into {recipients}</span>}
                            </>
                          )}
                        </p>
                      );
                    })()}
                  </div>
                )}

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
      </section>
    </div>
  );
}
