import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How Market Mountain sources, verifies, and publishes market news and equity research — from data collection to editorial quality gates.",
};

const sections = [
  {
    title: "News Discovery & Sourcing",
    content: `Market Mountain aggregates financial news from six independent sources running in parallel: Finnhub, NewsAPI, curated RSS feeds (Bloomberg, Financial Times, CNBC, Reuters, WSJ, and 20+ others), Marketaux, NewsData, and GNews. Each source operates independently — if one fails, the others continue without interruption. Articles are filtered by age (48-hour window), relevance (217 financial keyword matches), and source quality (domain blocklist removes entertainment, tabloid, and PR wire outlets).`,
  },
  {
    title: "Topic Grouping & Deduplication",
    content: `Raw articles are grouped by topic using keyword clustering and entity extraction. Groups with 2+ independent sources are prioritized over single-source stories. A multi-layer deduplication system prevents the same event from generating multiple articles: cross-run topic cooldowns (8-24 hours depending on category), entity-based event matching with canonical synonym normalization (e.g., "crude oil" and "WTI" map to the same entity), and headline similarity scoring with both raw and paraphrased matching.`,
  },
  {
    title: "AI-Powered Synthesis",
    content: `Each qualified topic group is synthesized into a single editorial article using Claude (Anthropic). The synthesis prompt enforces a Bloomberg/Financial Times editorial tone, structured output (headline, key takeaways, why it matters, second-order implications, what to watch), and single-story focus. Market data from FRED, BLS, EIA, and FMP is provided as context so Claude can ground claims in real numbers rather than hallucinating statistics.`,
  },
  {
    title: "Multi-Layer Fact-Checking",
    content: `Every synthesized article passes through four verification layers before publication:

Layer 1 — Heuristic plausibility scoring evaluates whether claims contain specific financial data (percentages, dollar amounts, basis points) and source attribution. Unsourced assertions score below the threshold and are rejected.

Layer 2 — Data verification cross-references 14 claim patterns against live government and market data from FRED, BLS, EIA, and FMP. Verified claims include Fed funds rate, 10-year yield, CPI, unemployment, payrolls, WTI crude, S&P 500, VIX, dollar index, GDP growth, mortgage rates, and gold prices. Each has calibrated tolerance bands (e.g., CPI within 0.2 percentage points, payrolls within 15% of claimed value).

Layer 3 — Source alignment uses AI to verify that every synthesized claim traces back to at least one source article. Claims that cannot be grounded are flagged as potential hallucinations.

Layer 4 — Entity relationship verification detects fabricated relationships (e.g., false M&A claims). Any fabricated relationship caps the composite score at 30/100, triggering automatic rejection.`,
  },
  {
    title: "Editorial Quality Gate",
    content: `Articles that pass fact-checking face an 18-test editorial quality assessment scoring 0-100. Tests include story worthiness, source quality (Tier 1/Tier 2 classification), title quality, thesis clarity, section structure, key takeaways, chart data quality, originality vs. recent coverage, editorial voice (detecting generic filler phrases), and data verification scores. The production threshold is 90/100 — articles must score A-grade across nearly every dimension to publish.`,
  },
  {
    title: "Source Tier System",
    content: `Sources are classified into tiers based on editorial standards. Tier 1 includes Reuters, Bloomberg, Associated Press, CNBC, Financial Times, Wall Street Journal, New York Times, The Economist, and Barron's. Tier 2 includes Yahoo Finance, MarketWatch, Seeking Alpha, Business Insider, Forbes, and CNN Business. Untiered sources receive lower confidence scores. Tier 1 sources receive a verification badge on the site.`,
  },
  {
    title: "Equity Research Methodology",
    content: `Long-form equity research uses multiple valuation models that must converge to support a price target. Primary methods include discounted cash flow (DCF) analysis with sensitivity tables varying WACC and long-term growth rate, EV/EBITDA multiples vs. peer group, P/E ratio analysis, and price-to-cash-flow comparisons. All articles include a DCF heatmap showing the range of fair values under different assumptions, explicit risk factors, and a clear investment thesis. Price targets and their performance are tracked on the Track Record page with live market prices.`,
  },
  {
    title: "Daily Briefing Generation",
    content: `The Daily Markets Briefing is automatically generated each trading day at 8:00 AM Eastern. It synthesizes the day's published stories into a lead story summary, top developments, key macroeconomic data (Fed funds, 10-year yield, 2s-10s spread, CPI, WTI crude, dollar index from live sources), and three forward-looking "What to Watch" items prioritized by the FMP economic calendar (FOMC decisions, CPI releases, NFP reports, GDP prints). The briefing maintains multi-day continuity — it references yesterday's watch items and generates follow-ups when events resolve.`,
  },
];

export default function MethodologyPage() {
  return (
    <div className="min-h-screen bg-surface">
      {/* Hero */}
      <section className="bg-navy-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <p className="text-accent-400 text-xs font-semibold tracking-[0.2em] uppercase mb-3">
            EDITORIAL STANDARDS
          </p>
          <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Methodology
          </h1>
          <p className="text-white/60 text-lg leading-relaxed max-w-2xl">
            How Market Mountain sources, verifies, and publishes financial news and equity
            research. Full transparency on every step of the editorial pipeline.
          </p>
        </div>
      </section>

      {/* Content */}
      <section className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-14">
        <div className="space-y-10">
          {sections.map((section, i) => (
            <div key={i}>
              <h2 className="text-xl font-serif font-bold text-text mb-3">
                {i + 1}. {section.title}
              </h2>
              <div className="prose prose-slate max-w-none">
                {section.content.split("\n\n").map((paragraph, j) => (
                  <p
                    key={j}
                    className="text-text-muted text-[15px] leading-relaxed mb-4"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Pipeline diagram */}
        <div className="mt-14 bg-card rounded-xl border border-border p-6 sm:p-8">
          <h3 className="text-sm font-bold tracking-widest uppercase text-text-light mb-4">
            Pipeline at a Glance
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
            {[
              "6 News Sources",
              "Age + Relevance Filter",
              "Topic Grouping",
              "Entity Dedup",
              "Claude Synthesis",
              "4-Layer Fact Check",
              "18-Test QA Gate",
              "KV Publish",
              "Briefing Generation",
              "Email Delivery",
            ].map((step, i) => (
              <span key={i} className="flex items-center gap-2">
                <span className="px-3 py-1.5 rounded-lg bg-navy-900 text-white">
                  {step}
                </span>
                {i < 9 && (
                  <svg className="w-4 h-4 text-accent-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* Footer note */}
        <p className="text-xs text-text-light mt-8 leading-relaxed">
          This methodology is continuously refined. The pipeline code is open for inspection
          and all thresholds, scoring weights, and editorial decisions are documented in the
          codebase.
        </p>
      </section>
    </div>
  );
}
