/** Client-safe article types and utilities (no Node.js deps). */

export interface ArticleMeta {
  slug: string;
  title: string;
  date: string;
  readTime: string;
  excerpt: string;
  coverImage?: string;
  coverImagePosition?: string;
  tags?: string[];
  updated?: string;
  disclaimer?: boolean;
  // Research metadata — for track record and ticker pages
  ticker?: string;               // Primary ticker (e.g., "FSLR", "SFM")
  priceTarget?: number;           // Price target in dollars
  priceAtPublish?: number;        // Stock price when article was published
  rating?: "buy" | "hold" | "sell" | "neutral" | "watchlist";
  targetHit?: boolean;             // Manually confirmed: did the stock reach the price target?
  disclosure?: string;            // Conflict of interest disclosure
}

export interface Article extends ArticleMeta {
  content: string;
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
