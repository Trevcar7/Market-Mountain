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
 *   - Off-topic category (e.g., crypto story with wrong image/framing)
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

  // ── March 15, 2026 — Iran/oil duplicate batch (geopolitics + inflation) ─
  // The canonical Iran/oil story is news-1773590264851-650 (energy topicKey).
  // These two are duplicate angles on the same ongoing event and are suppressed
  // in favor of the single primary "energy" article. The pipeline now uses
  // entity-based event matching (see fetch-news/route.ts) to prevent this
  // pattern in future runs.

  "news-1773590281732-1186",  // "Middle East Conflict Threatens Oil Export Routes, Forcing Rate Repricing" (geopolitics dup — same event)
  "news-1773539624109-964",   // "Iran Tensions Lift Oil Prices, Stoking Inflation Fears Before Fed Rate Decisions" (inflation dup — same event)

  // ── March 15, 2026 — Bitcoin article (deleted per editorial decision) ────
  // Bitcoin story published alongside the Iran/oil articles. Deleted because:
  //   1. Crypto price moves driven by geopolitical tension are lower-signal
  //   2. The article added little original analysis beyond the price level
  //   3. The feed already covered the underlying macro event (Iran/oil/inflation)
  // Future crypto articles must pass the standard QA gate and have a distinct
  // non-geopolitical catalyst (ETF flows, network metrics, regulatory action).

  "news-1773575410020-673",   // "Bitcoin Surges Past $73,000 Amid Geopolitical Tension and Institutional Inflows"

  // ── March 15, 2026 — Iran/oil canonical article (suppressed: update, not standalone) ──
  // This was the "canonical" Iran/oil article but it was an incremental update to the
  // same event covered since March 12, not a standalone analysis piece. Deleted as part
  // of the editorial pipeline audit. The improved pipeline will generate fresh standalone
  // articles on distinct events going forward.
  // To permanently remove from KV: POST /api/admin/clean-feed with all IDs in this set.

  "news-1773590264851-650",   // "Iran Crisis Lifts Oil, Strains Refiners and Reshapes Energy Supply Chains" (update article — same event since Mar 12)

  // ── March 19, 2026 — Fabricated Apple+IBM deal ────────────────────────
  // Pipeline merged two unrelated M&A stories (Apple acquiring MotionVFX +
  // IBM acquiring Confluent) and hallucinated a $70B Apple acquisition of
  // IBM Global Services that was never announced or reported.
  "news-1773770975678-1930",  // "Apple and IBM Lead M&A Wave as Tech Giants Pursue Creator Tools and Enterprise Integration"

  // ── March 20, 2026 — Duplicate MLB/CFTC sports betting article ───────
  // Same event (MLB + CFTC + Polymarket) was synthesized twice ~8h apart
  // with different wording ("MLB Secures…" vs "Baseball Gains…") — Jaccard
  // similarity 29% fell below the 50% headline-dedup threshold.
  // Keep the newer article (news-1773983327353-2050); suppress the older.
  "news-1773954083167-2050",  // "MLB Secures CFTC Approval for Polymarket Sports Betting Partnership"

]);
