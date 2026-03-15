import { Metadata } from "next";
import NewsSection from "@/components/NewsSection";

export const metadata: Metadata = {
  title: "Market News | Market Mountain",
  description:
    "Daily financial market news and analysis. Stay updated on Federal Reserve decisions, earnings reports, market trends, and economic events affecting your portfolio.",
  keywords: [
    "financial news",
    "market news",
    "stock market",
    "federal reserve",
    "earnings",
  ],
};

export default function NewsPage() {
  return (
    <main className="min-h-screen bg-surface">
      {/* Hero section */}
      <section className="bg-navy-900 text-white py-16 sm:py-20">
        <div className="container mx-auto px-4 sm:px-6 max-w-6xl">
          <div className="max-w-2xl">
            <h1 className="font-playfair text-4xl sm:text-5xl font-bold mb-4">
              Market News
            </h1>
            <p className="text-lg text-white/60">
              Curated daily market coverage — macroeconomic updates, Fed policy,
              earnings, and market-moving events that matter.
            </p>
          </div>
        </div>
      </section>

      {/* News grid */}
      <section className="container mx-auto px-4 sm:px-6 max-w-6xl py-12 sm:py-16">
        <div className="mb-8">
          <h2 className="font-playfair text-2xl font-bold text-navy-900 mb-2">
            Latest News
          </h2>
        </div>

        <NewsSection
          limit={50}
          showCategories={true}
          showSort={true}
        />
      </section>

    </main>
  );
}
