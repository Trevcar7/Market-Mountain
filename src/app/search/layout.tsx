import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Search",
  description: "Search Market Mountain articles, news, and stock coverage.",
};

export default function SearchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
