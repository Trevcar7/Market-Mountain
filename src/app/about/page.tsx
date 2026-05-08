import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "About",
  description:
    "Trevor Carnovsky, Finance and Accounting student at Central Michigan University, founder of Market Mountain, CFA Research Challenge Michigan Champion, RBC and PwC.",
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
          I&apos;m Trevor Carnovsky, a Finance and Accounting student at{" "}
          <strong>Central Michigan University</strong> (3.89 GPA, anticipated
          December 2026) and the founder of Market Mountain. I publish independent
          equity research, macro analysis, and automated daily market briefings
          built on institutional-grade data pipelines.
        </p>

        <h2>Professional Experience</h2>
        <p>
          I&apos;ll be joining <strong>Royal Bank of Canada</strong> in New York
          this summer as an incoming Operations Analyst Intern. Previously, I
          interned at <strong>PwC</strong> in Detroit on the Assurance team,
          where I executed audit testing for a $7B+ revenue energy and utility
          client under FERC and GAAP standards, analyzed financial statements
          and operational data to support testing of internal controls and
          account balances, and coordinated with client finance teams on
          documentation supporting audit procedures.
        </p>

        <h2>Investment Experience</h2>
        <p>
          I&apos;ve been a member of CMU&apos;s <strong>Student-Managed
          Investment Funds</strong> since 2023 and served as <strong>Co-Chair
          from 2025</strong>, leading investment research for a $4.4M
          multi-asset portfolio across equities and fixed income. As Co-Chair I
          designed and delivered DCF and comparable-company valuation workshops
          and presented portfolio performance and strategy to the Senior Alumni
          Advisory Board. I now serve as <strong>Co-Chair Emeritus and Senior
          Mentor</strong> through graduation.
        </p>
        <p>
          I founded <strong>Market Mountain</strong> in March 2025 to operate
          automated pipelines that generate daily market briefings, macro
          dashboards, and equity research analyzing competitive positioning,
          valuation frameworks, and macroeconomic trends.
        </p>

        <h2>Competitions</h2>
        <ul>
          <li>
            <strong>CFA Institute Research Challenge, Michigan Champion</strong>{" "}
            (February 2026). Led a five-month equity research process, authored
            the report, and presented a Buy thesis on Penske Automotive Group to
            a CFA charterholder panel.
          </li>
          <li>
            <strong>University of Florida Stock Pitch, 2nd Place out of 60+
            teams</strong> (February 2026). Built a bull/base/bear valuation on
            First Solar using DCF and trading multiples; pitched a thesis on
            technology leadership and domestic supply-chain advantages.
          </li>
          <li>
            <strong>University of Florida Financial Planning Competition, 1st
            Place</strong> (January 2025). Developed a financial plan integrating
            retirement modeling, tax strategy, and portfolio allocation for a
            family of five.
          </li>
          <li>
            <strong>ACG Cup Competition</strong>, Participant (2024 and 2026).
            Evaluated strategic M&amp;A alternatives and delivered
            valuation-based recommendations in live board-style presentations.
          </li>
        </ul>

        <h2>Honors</h2>
        <ul>
          <li>Provost&apos;s Award (one of two recipients college-wide)</li>
          <li>Outstanding Student of the Year (top 2.5% of 400+ graduating class)</li>
          <li>Voigtman Family Endowed Scholarship (competitive merit award)</li>
          <li>James H. Wanty Wealth Management Scholarship (largest finance scholarship at CMU)</li>
          <li>Michigan Finance Scholar</li>
          <li>L.A. Johns / Isabella Bank Endowed Scholarship</li>
        </ul>

        <h2>Certifications &amp; Skills</h2>
        <p>
          I hold the <strong>SIE</strong> and{" "}
          <strong>Bloomberg Market Concepts</strong> certifications and am
          currently a <strong>CFA Level I candidate</strong>. My technical
          toolkit includes advanced Excel, financial modeling, financial
          statement analysis, the Bloomberg Terminal, and SAP.
        </p>

        <h2>Research Methodology</h2>
        <p>
          Each equity analysis begins with a thorough review of a company&apos;s
          financial statements: income statement, balance sheet, and cash flow
          statement. Valuation methods I rely on include:
        </p>
        <ul>
          <li>
            <strong>Discounted Cash Flow (DCF)</strong>: intrinsic value based on
            projected free cash flows.
          </li>
          <li>
            <strong>EV / EBITDA</strong>: enterprise value relative to earnings
            before interest, taxes, depreciation, and amortization.
          </li>
          <li>
            <strong>P/E and P/CF multiples</strong>: peer-relative valuation
            benchmarking.
          </li>
          <li>
            <strong>Sensitivity analysis</strong>: WACC and growth-rate stress
            testing.
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
