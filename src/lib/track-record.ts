import { getAllArticles } from "./articles";
import type { ArticleMeta } from "./article-types";

export interface TrackRecordPick {
  ticker: string;
  title: string;
  slug: string;
  date: string;
  excerpt: string;
  tags: string[];
  priceTarget: number;
  priceAtPublish: number;
  rating: string;
  /** Manually confirmed from frontmatter — did the stock reach the price target? */
  targetHitConfirmed: boolean;
  /** Coverage lifecycle: active (thesis live), target-hit (reached), closed (no longer covering) */
  coverageStatus: "active" | "target-hit" | "closed";
  /** Optional note explaining coverage status (e.g., "Target reached May 2025") */
  coverageNote?: string;
  /** Date when price target was hit (YYYY-MM-DD) — used for closed picks to lock in returns */
  targetHitDate?: string;
  /** Days since publication */
  holdingDays: number;
  currentPrice?: number;
  returnSincePublish?: number;    // % return from publish price to current
  targetReturn?: number;           // % return from publish price to target (thesis return)
  /** True if confirmed via frontmatter OR if current price >= target */
  hitTarget?: boolean;
}

/**
 * Extract all picks with structured research metadata from articles.
 * Only includes articles that have a ticker + priceTarget + priceAtPublish.
 * Deduplicates by ticker — keeps the earliest entry (original pick).
 */
export function extractPicks(): TrackRecordPick[] {
  const articles = getAllArticles();
  const seenTickers = new Set<string>();

  return articles
    .filter(
      (a): a is ArticleMeta & { ticker: string; priceTarget: number; priceAtPublish: number; rating: string } =>
        !!a.ticker && !!a.priceTarget && !!a.priceAtPublish && !!a.rating
    )
    // Sort by date ascending so we keep the earliest pick per ticker
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((a) => {
      if (seenTickers.has(a.ticker.toUpperCase())) return false;
      seenTickers.add(a.ticker.toUpperCase());
      return true;
    })
    .map((a) => ({
      ticker: a.ticker,
      title: a.title,
      slug: a.slug,
      date: a.date,
      excerpt: a.excerpt,
      tags: a.tags ?? [],
      priceTarget: a.priceTarget,
      priceAtPublish: a.priceAtPublish,
      rating: a.rating,
      targetHitConfirmed: a.targetHit === true,
      coverageStatus: a.coverageStatus ?? (a.targetHit ? "target-hit" : "active"),
      coverageNote: a.coverageNote ?? undefined,
      targetHitDate: a.targetHitDate ?? undefined,
      holdingDays: Math.floor((Date.now() - new Date(a.date).getTime()) / 86400000),
      targetReturn: ((a.priceTarget - a.priceAtPublish) / a.priceAtPublish) * 100,
    }));
}
