import { getAllArticles } from "./articles";
import type { ArticleMeta } from "./article-types";

export interface TrackRecordPick {
  ticker: string;
  title: string;
  slug: string;
  date: string;
  priceTarget: number;
  priceAtPublish: number;
  rating: string;
  currentPrice?: number;
  returnSincePublish?: number;    // % return from publish price to current
  targetReturn?: number;           // % return from publish price to target
  hitTarget?: boolean;             // Did the stock reach the price target?
  spyReturnSamePeriod?: number;   // S&P 500 return over same period (for comparison)
}

/**
 * Extract all picks with structured research metadata from articles.
 * Only includes articles that have a ticker + priceTarget + priceAtPublish.
 */
export function extractPicks(): TrackRecordPick[] {
  const articles = getAllArticles();

  return articles
    .filter(
      (a): a is ArticleMeta & { ticker: string; priceTarget: number; priceAtPublish: number; rating: string } =>
        !!a.ticker && !!a.priceTarget && !!a.priceAtPublish && !!a.rating
    )
    .map((a) => ({
      ticker: a.ticker,
      title: a.title,
      slug: a.slug,
      date: a.date,
      priceTarget: a.priceTarget,
      priceAtPublish: a.priceAtPublish,
      rating: a.rating,
      targetReturn: ((a.priceTarget - a.priceAtPublish) / a.priceAtPublish) * 100,
    }));
}
