/** Shared search result type — used by API route, search page, and SearchBar. */
export interface SearchResult {
  type: "article" | "news";
  id: string;
  title: string;
  excerpt: string;
  url: string;
  date: string;
  category?: string;
  ticker?: string;
  relevance?: number;
}
