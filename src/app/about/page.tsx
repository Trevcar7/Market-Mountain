import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "About",
  description:
    "Trevor Carnovsky — equity researcher, investment analyst, and founder of Market Mountain. CFA Research Challenge champion, RBC Capital Markets, PwC.",
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-9 sm:py-20">
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
            className="text-3xl sm:text-4xl font-bold text-text font-playfair"
          >
            Trevor Carnovsky
          </h1>
        </div>
      </div>

      {/* Bio */}
      <div className="prose prose-slate max-w-none">
        <h2>Background</h2>
        <p>
          I&apos;m Trevor Carnovsky, an equity researcher and investment analyst
          with experience across capital markets, audit, and portfolio management.
          I founded Market Mountain to publish independent equity research, macro
          analysis, and automated daily market briefings built on institutional-grade
          data pipelines.
        </p>

        <p>
          My professional experience spans{" "}
          <strong>Royal Bank of Canada</strong> (Capital Markets operations) and{" "}
          <strong>PwC</strong> (assurance), where I executed audit testing for a
          $7B+ revenue energy and utility client under FERC and GAAP standards.
          I also co-chair a <strong>$4M student-managed investment fund</strong>,
          leading investment research across equities and fixed income and
          presenting strategy to the Senior Alumni Advisory Board.
        </p>

        <h2>Investment Research</h2>
        <p>
          My research has been recognized in national competition. I led the{" "}
          <strong>CFA Institute Research Challenge</strong> team that won the
          Michigan championship, authoring a five-month equity research report
          on Penske Automotive Group and presenting a Buy thesis to a CFA
          charterholder panel. I also placed 2nd out of 60+ teams at the{" "}
          <strong>University of Florida Stock Pitch Competition</strong>,
          building a bull/base/bear valuation on First Solar using DCF and
          trading multiples.
        </p>

        <p>
          I hold the <strong>SIE</strong> and{" "}
          <strong>Bloomberg Market Concepts</strong> certifications and am
          currently pursuing <strong>CFA Level I</strong>.
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
        <a
          href="https://www.linkedin.com/in/trevor-carnovsky/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full border border-border hover:border-accent-400 text-text-muted hover:text-text font-medium text-sm transition-colors"
          aria-label="Trevor Carnovsky on LinkedIn"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
          </svg>
          Connect on LinkedIn
        </a>
      </div>
    </div>
  );
}
