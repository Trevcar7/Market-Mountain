import fs from "fs";
import path from "path";
import matter from "gray-matter";
import readingTime from "reading-time";

const postsDirectory = path.join(process.cwd(), "src/content/posts");

export interface ArticleMeta {
  slug: string;
  title: string;
  date: string;
  readTime: string;
  excerpt: string;
  coverImage?: string;
  tags?: string[];
  updated?: string;
  disclaimer?: boolean;
}

export interface Article extends ArticleMeta {
  content: string;
}

export function getAllArticleSlugs(): string[] {
  if (!fs.existsSync(postsDirectory)) return [];
  return fs
    .readdirSync(postsDirectory)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

export function getAllArticles(): ArticleMeta[] {
  const slugs = getAllArticleSlugs();
  return slugs
    .map((slug) => getArticleMeta(slug))
    .filter(Boolean)
    .sort((a, b) => (a!.date < b!.date ? 1 : -1)) as ArticleMeta[];
}

export function getArticleMeta(slug: string): ArticleMeta | null {
  const filePath = path.join(postsDirectory, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, content } = matter(raw);
  const stats = readingTime(content);
  return {
    slug,
    title: data.title ?? slug,
    date: data.date ?? "",
    readTime: data.readTime ?? stats.text,
    excerpt: data.excerpt ?? content.slice(0, 160).replace(/[#*_]/g, "") + "…",
    coverImage: data.coverImage ?? undefined,
    tags: data.tags ?? [],
    updated: data.updated ?? undefined,
    disclaimer: data.disclaimer ?? false,
  };
}

export function getArticle(slug: string): Article | null {
  const filePath = path.join(postsDirectory, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, content } = matter(raw);
  const stats = readingTime(content);
  return {
    slug,
    title: data.title ?? slug,
    date: data.date ?? "",
    readTime: data.readTime ?? stats.text,
    excerpt: data.excerpt ?? content.slice(0, 160).replace(/[#*_]/g, "") + "…",
    coverImage: data.coverImage ?? undefined,
    tags: data.tags ?? [],
    updated: data.updated ?? undefined,
    disclaimer: data.disclaimer ?? false,
    content,
  };
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
