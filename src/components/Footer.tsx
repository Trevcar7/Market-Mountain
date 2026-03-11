import Link from "next/link";
import Logo from "./Logo";
import { getAllArticles } from "@/lib/articles";

export default function Footer() {
  const year = new Date().getFullYear();
  const recentArticles = getAllArticles().slice(0, 3);

  return (
    <footer className="bg-navy-900 text-white/70">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Top section */}
        <div className="py-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <div className="flex flex-col gap-3 max-w-sm">
            <Logo variant="light" size="sm" />
            <p className="text-sm text-white/50 leading-relaxed">
              Independent equity research and macroeconomic analysis by Trevor
              Carnovsky. Data-driven. Fundamental-first.
            </p>
            <a
              href="https://www.linkedin.com/in/trevor-carnovsky/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2.5 w-fit group"
              aria-label="Connect with Trevor Carnovsky on LinkedIn"
            >
              <span className="flex items-center justify-center w-8 h-8 rounded-md bg-[#0077B5] text-white group-hover:bg-[#005f93] transition-colors">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
              </span>
              <span className="text-sm text-white/50 group-hover:text-white/80 transition-colors">Connect on LinkedIn</span>
            </a>
          </div>

          <nav className="flex flex-col sm:flex-row gap-8" aria-label="Footer navigation">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold tracking-widest uppercase text-white/40 mb-1">
                Navigation
              </p>
              {[
                { href: "/", label: "Home" },
                { href: "/articles", label: "Articles" },
                { href: "/about", label: "About" },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm hover:text-accent-400 transition-colors"
                >
                  {link.label}
                </Link>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold tracking-widest uppercase text-white/40 mb-1">
                Recent
              </p>
              {recentArticles.map((article) => (
                <Link
                  key={article.slug}
                  href={`/post/${article.slug}`}
                  className="text-sm hover:text-accent-400 transition-colors line-clamp-1 max-w-[200px]"
                >
                  {article.title}
                </Link>
              ))}
            </div>
          </nav>
        </div>

        {/* Divider */}
        <div className="border-t border-white/10" />

        {/* Bottom */}
        <div className="py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-white/40">
            © {year} Market Mountain. All rights reserved.
          </p>
          <p className="text-xs text-white/50 text-center sm:text-right max-w-md">
            Content is for informational purposes only and does not constitute
            financial advice. Always perform your own due diligence.
          </p>
        </div>
      </div>
    </footer>
  );
}
