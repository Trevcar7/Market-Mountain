import type { NewsItem } from "./news-types";

/**
 * Score how related two news items are (0-100).
 * Uses topicKey overlap, ticker overlap, category match, and geoTheme overlap.
 */
function relatednessScore(a: NewsItem, b: NewsItem): number {
  if (a.id === b.id) return -1; // Exclude self

  let score = 0;

  // Same topic key (strongest signal)
  if (a.topicKey && b.topicKey && a.topicKey === b.topicKey) {
    score += 40;
  }

  // Same category
  if (a.category === b.category) {
    score += 15;
  }

  // Ticker overlap
  const aTickers = new Set(a.relatedTickers ?? []);
  const bTickers = new Set(b.relatedTickers ?? []);
  if (aTickers.size > 0 && bTickers.size > 0) {
    const overlap = [...aTickers].filter((t) => bTickers.has(t)).length;
    const maxPossible = Math.min(aTickers.size, bTickers.size);
    if (maxPossible > 0) {
      score += Math.round((overlap / maxPossible) * 30);
    }
  }

  // Geo theme overlap
  const aGeo = new Set(a.geoThemes ?? []);
  const bGeo = new Set(b.geoThemes ?? []);
  if (aGeo.size > 0 && bGeo.size > 0) {
    const overlap = [...aGeo].filter((t) => bGeo.has(t)).length;
    if (overlap > 0) score += 15;
  }

  // Same event (strongest possible signal)
  if (a.eventId && b.eventId && a.eventId === b.eventId) {
    score += 50;
  }

  // Recency bonus: prefer newer related stories
  const bAge = Date.now() - new Date(b.publishedAt).getTime();
  const hoursSincePublish = bAge / (1000 * 60 * 60);
  if (hoursSincePublish < 12) score += 5;
  else if (hoursSincePublish < 24) score += 3;

  return Math.min(100, score);
}

/**
 * Find the top N related stories for a given news item.
 * Returns stories sorted by relatedness score (highest first).
 */
export function findRelatedStories(
  current: NewsItem,
  allStories: NewsItem[],
  count = 3,
  minScore = 10
): NewsItem[] {
  return allStories
    .map((story) => ({ story, score: relatednessScore(current, story) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ story }) => story);
}
