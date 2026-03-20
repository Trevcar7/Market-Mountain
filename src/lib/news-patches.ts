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
  clearChart?: boolean;
  clearKeyData?: boolean;
  clearInlineImage?: boolean;
}

export const ARTICLE_PATCHES: ArticlePatch[] = [
  // NVIDIA → official NVIDIA logo (green eye + wordmark); strip bad AMD inline image
  { test: /\bnvidia\b|\bNVDA\b|\bjensen huang\b|\bblackwell\b|\bgeforce\b/i, imageUrl: "/images/nvidia-logo.png", clearInlineImage: true },
  // Bentley → luxury car (Continental GT logo)
  { test: /\bbentley\b/i, imageUrl: "https://images.unsplash.com/photo-1661683769067-1ebc0e7aa7b6?w=1200&q=80", relatedTickers: { TSLA: "VWAGY" } },
  // Humana / managed care → healthcare
  { test: /\bhumana\b|\bmanaged care\b/i, imageUrl: "https://images.unsplash.com/photo-1638202993928-7267aad84c31?w=1200&q=80" },
  // Apple + IBM M&A → tech corporate; strip inline image
  { test: /\bibm\b.*\bapple\b|\bapple\b.*\bibm\b/i, imageUrl: "https://images.unsplash.com/photo-1722537273895-b35dfbd273ee?w=1200&q=80", clearInlineImage: true },
  // MLB / baseball / sports betting → baseball stadium (strip irrelevant macro data + inline image)
  { test: /\bmlb\b|\bbaseball\b|\bsports betting\b/i, imageUrl: "https://images.unsplash.com/photo-1471295253337-3ceaaedca402?w=1200&q=80", category: "markets", clearKeyData: true, clearInlineImage: true },
  // Meta content moderation / AI → Facebook + Messenger 3D icons (strip irrelevant macro data + wall street inline image)
  { test: /\bmeta\b.*\bcontent\b|\bmeta\b.*\bmoderation\b|\bmeta\b.*\bfacebook\b/i, imageUrl: "https://images.unsplash.com/photo-1611162618071-b39a2ec055fb?w=1200&q=80", category: "markets", clearKeyData: true, clearInlineImage: true },
  // OpenAI / AI acquisition → AI visualization (strip irrelevant GOOGL chart + treasury data)
  { test: /\bopenai\b/i, imageUrl: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80", category: "markets", clearChart: true, clearKeyData: true },
  // Iran + LNG / Qatar / crude strike → oil tanks with storm clouds
  { test: /\biran\b.*\b(?:lng|qatar|crude|strike|brent)\b/i, imageUrl: "https://images.unsplash.com/photo-1693847173071-bd6237101335?w=1200&q=80" },
  // Iran (general / Fed / inflation) → oil refinery at night; strip money inline image
  { test: /\biran\b/i, imageUrl: "https://images.unsplash.com/photo-1580561346873-4a76a13dce92?w=1200&q=80", clearInlineImage: true },
  // Lululemon / athletic retail → yoga fitness class; strip inline image
  { test: /\blululemon\b/i, imageUrl: "https://images.unsplash.com/photo-1518611012118-696072aa579a?w=1200&q=80", clearInlineImage: true },
  // Stagflation / GDP collapse → stock market crash / red tape; strip foreign market inline image
  { test: /\bstagflation\b/i, imageUrl: "https://images.unsplash.com/photo-1579532537598-459ecdaf39cc?w=1200&q=80", clearInlineImage: true },
  // Novartis → keep existing image, strip out-of-place pill inline image
  { test: /\bnovartis\b/i, imageUrl: "https://images.unsplash.com/photo-1752159684779-0639174cdfac?w=1200&q=80", clearInlineImage: true },
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

/** Apply all article patches to a single NewsItem (mutates nothing). */
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
      if (patch.clearChart) {
        patched.chartData = undefined;
      }
      if (patch.clearKeyData) {
        patched.keyDataPoints = undefined;
      }
      if (patch.clearInlineImage) {
        patched.inlineImageUrl = undefined;
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
