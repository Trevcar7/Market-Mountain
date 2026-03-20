import type { NewsItem } from "@/lib/news-types";

/**
 * Centralized article patches — applied identically on:
 *   - GET /api/news (feed cards)
 *   - /news/[id] detail page
 *
 * Each patch matches on title keywords and overrides imageUrl, category, and/or
 * relatedTickers. First matching patch wins (break after match).
 *
 * Category-level fallback images are applied after patches for any article
 * still missing an imageUrl.
 */

interface ArticlePatch {
  test: RegExp;
  imageUrl: string;
  category?: string;
  relatedTickers?: Record<string, string>;
}

export const ARTICLE_PATCHES: ArticlePatch[] = [
  // NVIDIA → GPU render
  { test: /\bnvidia\b|\bNVDA\b/i, imageUrl: "https://images.unsplash.com/photo-1617854818583-09e7f077a156?w=1200&q=80" },
  // Bentley → luxury car (Continental GT logo)
  { test: /\bbentley\b/i, imageUrl: "https://images.unsplash.com/photo-1661683769067-1ebc0e7aa7b6?w=1200&q=80", relatedTickers: { TSLA: "VWAGY" } },
  // Humana / managed care → healthcare
  { test: /\bhumana\b|\bmanaged care\b/i, imageUrl: "https://images.unsplash.com/photo-1638202993928-7267aad84c31?w=1200&q=80" },
  // Apple + IBM M&A → tech corporate
  { test: /\bibm\b.*\bapple\b|\bapple\b.*\bibm\b/i, imageUrl: "https://images.unsplash.com/photo-1722537273895-b35dfbd273ee?w=1200&q=80" },
  // MLB / baseball / sports betting → baseball stadium
  { test: /\bmlb\b|\bbaseball\b|\bsports betting\b/i, imageUrl: "https://images.unsplash.com/photo-1471295253337-3ceaaedca402?w=1200&q=80", category: "markets" },
  // Meta content moderation / AI → Meta HQ exterior
  { test: /\bmeta\b.*\bcontent\b|\bmeta\b.*\bmoderation\b|\bmeta\b.*\bfacebook\b/i, imageUrl: "https://images.unsplash.com/photo-1633419461186-7d40a38105ec?w=1200&q=80", category: "markets" },
  // OpenAI / AI acquisition → AI neural visualization
  { test: /\bopenai\b/i, imageUrl: "https://images.unsplash.com/photo-1677756119517-756a188d2d94?w=1200&q=80", category: "markets" },
  // Iran strike / LNG / crude → oil refinery at night
  { test: /\biran\b/i, imageUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&q=80" },
  // Lululemon / athletic retail → retail store interior
  { test: /\blululemon\b/i, imageUrl: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200&q=80" },
  // Stagflation / GDP collapse → stock market crash / red tape
  { test: /\bstagflation\b/i, imageUrl: "https://images.unsplash.com/photo-1579532537598-459ecdaf39cc?w=1200&q=80" },
  // Jio / Reliance IPO → India / emerging market
  { test: /\bjio\b|\breliance\b/i, imageUrl: "https://images.unsplash.com/photo-1468254095679-bbcba94a7066?w=1200&q=80" },
];

/** Category fallback: used when no patch matches and article has no imageUrl */
export const CATEGORY_FALLBACK_IMAGES: Record<string, string> = {
  macro:    "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1200&q=80",
  earnings: "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80",
  markets:  "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  crypto:   "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80",
  policy:   "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=1200&q=80",
};

/** Apply all article patches to a single NewsItem. Returns a new object. */
export function applyArticlePatches(item: NewsItem): NewsItem {
  let patched = { ...item };
  const title = patched.title ?? "";

  for (const patch of ARTICLE_PATCHES) {
    if (patch.test.test(title)) {
      patched.imageUrl = patch.imageUrl;
      if (patch.category) {
        patched.category = patch.category as NewsItem["category"];
      }
      if (patch.relatedTickers && patched.relatedTickers) {
        patched.relatedTickers = patched.relatedTickers.map(
          (t) => patch.relatedTickers![t] ?? t
        );
      }
      break;
    }
  }

  // Category fallback if still no image
  if (!patched.imageUrl) {
    patched.imageUrl = CATEGORY_FALLBACK_IMAGES[patched.category] ?? CATEGORY_FALLBACK_IMAGES.macro;
  }

  return patched;
}
