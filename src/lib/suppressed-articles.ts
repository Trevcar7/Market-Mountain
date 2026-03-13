/**
 * Administratively suppressed article IDs.
 *
 * Articles in this set are filtered from the news feed and individual
 * article pages without modifying the underlying KV store.
 *
 * Reasons for suppression:
 *   - Near-duplicate stories on the same macro event
 *   - Low editorial quality (commentator opinion, not original reporting)
 *   - Superseded by a better-sourced article on the same topic
 *
 * Note: All March 12, 2026 articles are also filtered by the date cutoff
 * in /api/news/route.ts (MARCH_13_CUTOFF_MS). IDs below are kept for
 * legacy article page suppression (direct URL access).
 *
 * To suppress additional articles, add their ID here and deploy.
 * To permanently clean KV, use POST /api/admin/clean-feed with these IDs.
 */
export const SUPPRESSED_ARTICLE_IDS = new Set<string>([
  // March 12, 2026 — near-duplicate Iran/oil batch (also blocked by date cutoff)
  "news-1773359618025-428",   // "Iran tensions lift oil prices, forcing emerging markets to delay rate cuts" (dup)
  "news-1773359607257-428",   // "Iran tensions lift oil prices, forcing emerging markets to pause rate cuts" (dup)
  "news-1773359603846-1909",  // "Cramer Warns Against Panic Selling as Iran Tensions Roil Markets" (low quality)
  "news-1773359599784-964",   // "Global inflation remains contained as geopolitical tensions threaten oil prices" (dup)
]);
