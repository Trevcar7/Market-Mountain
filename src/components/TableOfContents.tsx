"use client";

import { useEffect, useState } from "react";
import type { Heading } from "@/lib/parse-headings";

interface TableOfContentsProps {
  headings: Heading[];
}

export default function TableOfContents({ headings }: TableOfContentsProps) {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "0px 0px -60% 0px", threshold: 0 }
    );

    headings.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length < 3) return null;

  return (
    <nav aria-label="Table of contents" className="sticky top-24">
      <p className="text-[10px] font-bold tracking-widest uppercase text-text-light mb-3">
        Contents
      </p>
      <ul className="space-y-1">
        {headings.map(({ id, text }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={`block text-xs leading-snug py-1 pl-3 border-l-2 transition-colors duration-150 ${
                activeId === id
                  ? "border-accent-500 text-navy-900 font-semibold"
                  : "border-border text-text-muted hover:text-navy-700 hover:border-navy-300"
              }`}
            >
              {text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

