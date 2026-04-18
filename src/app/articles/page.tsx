import { getAllArticles } from "@/lib/articles";
import ArticleFilter from "@/components/ArticleFilter";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Articles",
  description:
    "All equity research, market commentary, and macroeconomic analysis from Market Mountain.",
};

export default function ArticlesPage() {
  const articles = getAllArticles();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 sm:py-16">
      {/* Page header */}
      <div className="mb-10 sm:mb-14 border-b border-border pb-8">
        <p className="text-xs font-semibold tracking-widest uppercase text-accent-600 mb-2">
          Research & Analysis
        </p>
        <h1
          className="text-3xl sm:text-4xl font-bold text-text mb-3 font-playfair"
        >
          All Articles
        </h1>
        <p className="text-text-muted text-base max-w-xl">
          Equity research, market commentary, and macroeconomic analysis.
        </p>
      </div>

      <ArticleFilter articles={articles} />
    </div>
  );
}
