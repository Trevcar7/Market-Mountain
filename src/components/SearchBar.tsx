"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { SearchResult } from "@/lib/search-types";

interface SearchBarProps {
  /** "dark" for dark nav backgrounds (hero), "light" for light backgrounds */
  variant?: "dark" | "light";
  /** "desktop" shows full button with shortcut, "mobile" shows icon only */
  display?: "desktop" | "mobile";
}

export default function SearchBar({ variant = "dark", display = "desktop" }: SearchBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isMac, setIsMac] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Detect platform for shortcut display
  useEffect(() => {
    setIsMac(navigator.platform?.toLowerCase().includes("mac") ?? true);
  }, []);

  // cmd+K / ctrl+K to open
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults(data.results ?? []);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  const navigate = useCallback(
    (url: string) => {
      setOpen(false);
      router.push(url);
    },
    [router]
  );

  // Keyboard navigation
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      navigate(results[selectedIndex].url);
    }
  }

  const shortcutLabel = isMac ? "⌘K" : "Ctrl+K";

  if (!open) {
    // Mobile: icon-only button
    if (display === "mobile") {
      const mobileColors = variant === "dark"
        ? "text-white/70 hover:text-white hover:bg-white/10"
        : "text-text-muted hover:text-navy-900 hover:bg-navy-50";
      return (
        <button
          onClick={() => setOpen(true)}
          className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${mobileColors}`}
          aria-label={`Search (${shortcutLabel})`}
        >
          <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      );
    }

    // Desktop: full button with shortcut hint
    const desktopColors = variant === "dark"
      ? "border-white/15 text-white/40 hover:text-white/70 hover:border-white/30"
      : "border-border text-text-light hover:text-text-muted hover:border-border-2";
    const kbdColors = variant === "dark" ? "bg-white/10" : "bg-surface-2 text-text-light";

    return (
      <button
        onClick={() => setOpen(true)}
        className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors ${desktopColors}`}
        aria-label={`Search (${shortcutLabel})`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span>Search</span>
        <kbd className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${kbdColors}`}>
          {shortcutLabel}
        </kbd>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-navy-900/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg mx-4 bg-card rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search articles, news, tickers..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 py-3.5 bg-transparent text-text text-sm placeholder-text-light outline-none"
          />
          <kbd
            className="px-1.5 py-0.5 rounded bg-surface-2 text-[10px] text-text-light font-mono cursor-pointer"
            onClick={() => setOpen(false)}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto">
          {loading && (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              Searching...
            </div>
          )}

          {!loading && query.length >= 2 && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {results.map((result, i) => (
            <button
              key={`${result.type}-${result.id}`}
              onClick={() => navigate(result.url)}
              className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${
                i === selectedIndex ? "bg-accent-50" : "hover:bg-surface"
              } ${i > 0 ? "border-t border-border/50" : ""}`}
            >
              {/* Type badge */}
              <span
                className={`shrink-0 mt-0.5 text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded ${
                  result.type === "article"
                    ? "bg-accent-100 text-accent-700"
                    : "bg-navy-100 text-navy-600"
                }`}
              >
                {result.type === "article" ? "Article" : "News"}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text line-clamp-1">
                  {result.title}
                </p>
                <p className="text-xs text-text-muted line-clamp-1 mt-0.5">
                  {result.excerpt}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  {result.ticker && (
                    <span className="text-[10px] font-bold text-accent-600">
                      ${result.ticker}
                    </span>
                  )}
                  {result.category && (
                    <span className="text-[10px] text-text-light">
                      {result.category}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div className="px-4 py-2 border-t border-border bg-surface-2 flex items-center gap-4 text-[10px] text-text-light">
            <span><kbd className="font-mono">&#8593;&#8595;</kbd> Navigate</span>
            <span><kbd className="font-mono">&#9166;</kbd> Open</span>
            <span><kbd className="font-mono">Esc</kbd> Close</span>
          </div>
        )}
      </div>
    </div>
  );
}
