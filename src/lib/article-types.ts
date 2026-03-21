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
