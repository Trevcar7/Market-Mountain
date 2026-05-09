"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Logo from "./Logo";
import ThemeToggle from "./ThemeToggle";
import SearchBar from "./SearchBar";

const navLinks = [
  { href: "/", label: "Home" },
  { href: "/news", label: "News" },
  { href: "/briefing", label: "Briefing" },
  { href: "/articles", label: "Articles" },
  { href: "/track-record", label: "Track Record" },
  { href: "/about", label: "About" },
];

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 12);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  // Detect dark mode so the navbar uses light-on-dark styling on all pages
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Close menu on route change — derived during render (React-recommended pattern
  // for resetting state when a dependency changes, avoids a cascading useEffect).
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setMenuOpen(false);
  }

  const isHeroPage = pathname === "/";
  // Use dark-navy styling when: (a) hero page before scroll, OR (b) dark mode on any page
  const useDarkNav = (isHeroPage && !scrolled) || isDark;

  return (
    <header
      className={`sticky top-0 z-50 w-full transition-all duration-300 ${
        useDarkNav
          ? "bg-navy-900 border-b border-white/10"
          : "bg-card/95 backdrop-blur-md border-b border-border shadow-sm"
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Logo
            variant={useDarkNav ? "light" : "dark"}
            size="sm"
          />

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1" aria-label="Main navigation">
            {navLinks.map((link) => {
              const active =
                pathname === link.href ||
                (link.href === "/articles" && pathname.startsWith("/post/")) ||
                (link.href === "/news" && pathname.startsWith("/news/"));
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative px-4 py-2 text-sm font-medium tracking-wide transition-colors duration-150 ${
                    useDarkNav
                      ? active
                        ? "text-white"
                        : "text-white/60 hover:text-white"
                      : active
                      ? "text-text"
                      : "text-text-muted hover:text-text"
                  }`}
                >
                  {link.label}
                  {active && (
                    <span
                      className={`absolute bottom-0 left-4 right-4 h-[2px] rounded-full ${
                        useDarkNav ? "bg-accent-400" : "bg-accent-500"
                      }`}
                      aria-hidden="true"
                    />
                  )}
                </Link>
              );
            })}
            <SearchBar variant={useDarkNav ? "dark" : "light"} display="desktop" />
            <ThemeToggle variant={useDarkNav ? "dark" : "light"} />
          </nav>

          {/* Mobile: search + theme + hamburger */}
          <div className="md:hidden flex items-center gap-1">
            <SearchBar variant={useDarkNav ? "dark" : "light"} display="mobile" />
            <ThemeToggle variant={useDarkNav ? "dark" : "light"} />
            <button
              className={`flex flex-col justify-center items-center w-10 h-10 rounded-md gap-1.5 transition-colors ${
                useDarkNav
                  ? "hover:bg-white/10"
                  : "hover:bg-surface-2"
              }`}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
          >
            <span
              className={`block w-5 h-0.5 transition-all duration-200 ${
                useDarkNav ? "bg-white" : "bg-text"
              } ${menuOpen ? "translate-y-2 rotate-45" : ""}`}
            />
            <span
              className={`block w-5 h-0.5 transition-all duration-200 ${
                useDarkNav ? "bg-white" : "bg-text"
              } ${menuOpen ? "opacity-0 scale-x-0" : ""}`}
            />
            <span
              className={`block w-5 h-0.5 transition-all duration-200 ${
                useDarkNav ? "bg-white" : "bg-text"
              } ${menuOpen ? "-translate-y-2 -rotate-45" : ""}`}
            />
          </button>
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      <div
        className={`md:hidden overflow-hidden transition-all duration-300 ${
          menuOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        } ${useDarkNav ? "bg-navy-800 border-t border-white/10" : "bg-card border-t border-border"}`}
      >
        <nav className="px-4 py-3 flex flex-col gap-1" aria-label="Mobile navigation">
          {navLinks.map((link) => {
            const active =
              pathname === link.href ||
              (link.href === "/articles" && pathname.startsWith("/post/")) ||
              (link.href === "/news" && pathname.startsWith("/news/"));
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  useDarkNav
                    ? active
                      ? "bg-white/15 text-accent-400"
                      : "text-white/80 hover:bg-white/10 hover:text-white"
                    : active
                    ? "bg-surface-2 text-text"
                    : "text-text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
