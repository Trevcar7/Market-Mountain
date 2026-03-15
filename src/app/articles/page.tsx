import { getAllArticles } from "@/lib/articles";
import ArticleCard from "@/components/ArticleCard";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Articles",
  description:
    "All equity research, market commentary, and macroeconomic analysis from Market Mountain.",
};

export default function ArticlesPage() {
  const articles = getAllArticles();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
      {/* Page header */}
      <div className="mb-10 sm:mb-14 border-b border-border pb-8">
        <p className="text-xs font-semibold tracking-widest uppercase text-accent-600 mb-2">
          Research & Analysis
        </p>
        <h1
          className="text-3xl sm:text-4xl font-bold text-navy-900 mb-3"
          style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
        >
          All Articles
        </h1>
        <p className="text-text-muted text-base max-w-xl">
          Equity research, market commentary, and macroeconomic analysis.
        </p>
      </div>

      {articles.length === 0 ? (
        <p className="text-text-muted text-center py-20">
          No articles published yet — check back soon.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
          {articles.map((article) => (
            <ArticleCard key={article.slug} article={article} />
          ))}
        </div>
      )}
    </div>
  );
}
