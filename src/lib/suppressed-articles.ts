/**
 * Administratively suppressed article IDs.
 *
 * Articles in this set are filtered from the news feed and individual
 * article pages without modifying the underlying KV store.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * EDITORIAL SUPPRESSION POLICY
 * ──────────────────────────────────────────────────────────────────────────
 * Suppression reasons:
 *   - Near-duplicate stories on the same macro event (same topicKey, <24h apart)
 *   - Low editorial quality (commentator opinion, no original reporting)
 *   - Superseded by a better-sourced article on the same topic
 *   - Wrong/misleading image (e.g., wind turbine on an oil price story)
 *   - QA score < 85 on post-publish review
 *
 * How to suppress additional articles:
 *   1. Add their ID to this set
 *   2. Deploy — articles disappear from feed without KV modification
 *   3. To permanently clean KV, use POST /api/admin/clean-feed with these IDs
 *
 * Note: All March 12, 2026 articles are also filtered by the date cutoff
 * in /api/news/route.ts (MARCH_13_CUTOFF_MS). IDs below are kept for
 * legacy article page suppression (direct URL access).
 * ──────────────────────────────────────────────────────────────────────────
 */
export const SUPPRESSED_ARTICLE_IDS = new Set<string>([

  // ── March 12, 2026 — Iran/oil duplicate batch ───────────────────────────
  // These four articles all cover the same macro event (Iran tensions → oil spike)
  // and were generated within seconds of each other. Only the best-analyzed
  // version of the "energy" topicKey should remain in the feed.
  // All four are also blocked by the MARCH_13_CUTOFF_MS date filter, but IDs
  // are retained here to suppress direct /news/[id] URL access.

  "news-1773359618025-428",   // "Iran tensions lift oil prices, forcing emerging markets to delay rate cuts" (dup #1)
  "news-1773359607257-428",   // "Iran tensions lift oil prices, forcing emerging markets to pause rate cuts" (dup #2)
  "news-1773359603846-1909",  // "Cramer Warns Against Panic Selling as Iran Tensions Roil Markets" (low quality — commentator opinion)
  "news-1773359599784-964",   // "Global inflation remains contained as geopolitical tensions threaten oil prices" (dup #3 — wrong topic framing)

]);
