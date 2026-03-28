"use client";

import { useEffect, useState } from "react";

interface ThemeToggleProps {
  /** "dark" for dark nav backgrounds (hero), "light" for light backgrounds */
  variant?: "dark" | "light";
}

/**
 * Dark mode toggle — class-based (html.dark) with localStorage persistence.
 * Respects prefers-color-scheme on first visit, then uses stored preference.
 */
export default function ThemeToggle({ variant = "dark" }: ThemeToggleProps) {
  const [isDark, setIsDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem("mm-theme");
    if (stored === "dark") {
      setIsDark(true);
      document.documentElement.classList.add("dark");
    } else if (stored === "light") {
      setIsDark(false);
      document.documentElement.classList.remove("dark");
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setIsDark(prefersDark);
      if (prefersDark) document.documentElement.classList.add("dark");
    }
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("mm-theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("mm-theme", "light");
    }
  }

  if (!mounted) return <div className="w-9 h-9" />;

  const colors = variant === "dark"
    ? "text-white/60 hover:text-white hover:bg-white/10"
    : "text-text-muted hover:text-navy-900 hover:bg-navy-50";

  return (
    <button
      onClick={toggle}
      className={`relative w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${colors}`}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      {isDark ? (
        <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ) : (
        <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}
