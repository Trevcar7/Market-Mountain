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
  coverageStatus?: "active" | "target-hit" | "closed";  // Track record status
  coverageNote?: string;           // e.g., "Target reached May 2025. Coverage ended."
  targetHitDate?: string;          // YYYY-MM-DD when price target was reached (for closed/target-hit picks)
  /** Optional partial sale — locks in gains on a fraction of the hypothetical position */
  partialSale?: {
    date: string;        // YYYY-MM-DD
    fraction: number;    // 0–1 (e.g., 0.5 for half)
    salePrice: number;   // execution price for the sold fraction
    note?: string;       // rationale shown on the track-record card
  };
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
