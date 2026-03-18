import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "About",
  description:
    "Trevor Carnovsky — CMU student, equity researcher, and founder of Market Mountain.",
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-14 sm:py-20">
      {/* Header */}
      <div className="mb-10 border-b border-border pb-8">
        <p className="text-xs font-semibold tracking-widest uppercase text-accent-600 mb-4">
          About
        </p>
        <div className="flex items-center gap-6 mb-4">
          <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-full overflow-hidden flex-shrink-0 shadow-lg ring-4 ring-accent-500/20">
            <Image
              src="/images/trevor.jpg"
              alt="Trevor Carnovsky"
              width={256}
              height={256}
              quality={90}
              priority
              className="object-cover w-full h-full"
            />
          </div>
          <h1
            className="text-3xl sm:text-4xl font-bold text-navy-900 font-playfair"
          >
            Trevor Carnovsky
          </h1>
        </div>
      </div>

      {/* Bio */}
      <div className="prose prose-slate max-w-none">
        <p>
          I&apos;m Trevor Carnovsky, a student at Central Michigan University
          with a strong interest in financial markets and long-term value
          creation. Through Market Mountain, I share thoughtful perspectives on
          market conditions, macroeconomic developments, and in-depth analysis
          of individual equities.
        </p>

        <p>
          My work emphasizes data-driven analysis, fundamental research, and
          disciplined investment frameworks. The goal is to present clear,
          well-reasoned insights that help readers better understand how market
          forces, company fundamentals, and risk considerations interact in
          real-world investing.
        </p>

        <p>
          Whether exploring broader market trends or evaluating specific
          investment opportunities, this platform is intended to serve as a
          resource for those interested in disciplined, research-oriented
          approaches to finance.
        </p>

        <h2>Methodology</h2>
        <p>
          Each equity analysis begins with a thorough review of a company&apos;s
          financial statements — income statement, balance sheet, and cash flow
          statement. Valuation methods used include:
        </p>
        <ul>
          <li>
            <strong>Discounted Cash Flow (DCF)</strong> — Intrinsic value based on
            projected free cash flows
          </li>
          <li>
            <strong>EV / EBITDA</strong> — Enterprise value relative to earnings
            before interest, taxes, depreciation, and amortization
          </li>
          <li>
            <strong>P/E and P/CF Multiples</strong> — Peer-relative valuation
            benchmarking
          </li>
          <li>
            <strong>Sensitivity Analysis</strong> — WACC and growth rate stress
            testing
          </li>
        </ul>

        <h2>Disclaimer</h2>
        <p>
          All content on Market Mountain is for informational and educational
          purposes only. Nothing published here constitutes financial advice.
          Always perform your own research and due diligence before making any
          investment decisions. Past performance is not indicative of future
          results.
        </p>
      </div>

      {/* CTA */}
      <div className="mt-10 flex flex-col sm:flex-row gap-3">
        <Link
          href="/articles"
          className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-navy-900 hover:bg-navy-800 text-white font-medium text-sm transition-colors"
        >
          Read the Research
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </Link>
      </div>
    </div>
  );
}
