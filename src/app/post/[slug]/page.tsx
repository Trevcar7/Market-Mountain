import { getArticle, getAllArticles, getAllArticleSlugs, formatDate } from "@/lib/articles";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import DCFHeatmap from "@/components/DCFHeatmap";
import BarChart from "@/components/BarChart";
import DataTable from "@/components/DataTable";
import ReadingProgress from "@/components/ReadingProgress";
import ArticleCard from "@/components/ArticleCard";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return getAllArticleSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) return {};
  return {
    title: article.title,
    description: article.excerpt,
    alternates: { canonical: `/post/${slug}` },
    openGraph: {
      title: article.title,
      description: article.excerpt,
      type: "article",
      publishedTime: article.date,
      ...(article.coverImage
        ? { images: [{ url: article.coverImage, width: 1200, height: 630 }] }
        : {}),
    },
  };
}

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  const related = getAllArticles()
    .filter((a) => a.slug !== slug)
    .slice(0, 3);

  return (
    <>
      <ReadingProgress />

      {/* Article hero */}
      <div className="bg-navy-900 text-white">
        {article.coverImage && (
          <div className="relative h-56 sm:h-72 md:h-96 overflow-hidden">
            <Image
              src={article.coverImage}
              alt={article.title}
              fill
              className="object-cover opacity-40"
              style={article.coverImagePosition ? { objectPosition: article.coverImagePosition } : undefined}
              priority
              sizes="100vw"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-navy-900 via-navy-900/60 to-navy-900/20" />
          </div>
        )}

        <div className="mx-auto max-w-[680px] px-4 sm:px-6 py-12 sm:py-18 md:py-22">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-[11px] text-white/35 mb-5" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-white/60 transition-colors">Home</Link>
            <span aria-hidden="true">/</span>
            <Link href="/articles" className="hover:text-white/60 transition-colors">Articles</Link>
            <span aria-hidden="true">/</span>
            <span className="text-white/55 line-clamp-1">{article.title}</span>
          </nav>

          {/* Tags */}
          {article.tags && article.tags.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-5">
              {article.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-block text-xs font-semibold tracking-wider uppercase text-accent-300 bg-white/10 px-2 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Title */}
          <h1
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-[1.15] tracking-tight mb-6 font-playfair"
          >
            {article.title}
          </h1>

          {/* Meta */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-white/40 text-[11px] tracking-widest uppercase">
            <Link href="/about" className="text-white/55 hover:text-white/80 transition-colors font-medium normal-case tracking-normal text-xs">
              By Trevor Carnovsky
            </Link>
            <span className="text-white/30" aria-hidden="true">·</span>
            <time dateTime={article.date}>{formatDate(article.date)}</time>
            <span className="text-white/30" aria-hidden="true">·</span>
            <span>{article.readTime}</span>
            {article.updated && article.updated !== article.date && (
              <>
                <span className="text-white/30" aria-hidden="true">·</span>
                <span>Updated {formatDate(article.updated)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Accent divider */}
      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

      {/* Article body */}
      <article className="mx-auto max-w-[680px] px-4 sm:px-6 py-10 sm:py-14">
        <div className="prose prose-slate max-w-none">
          <MDXRemote
            source={article.content}
            components={{ DCFHeatmap, BarChart, DataTable }}
            options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
          />
        </div>

        {/* Disclaimer */}
        {article.disclaimer !== false && (
          <div className="mt-10 p-4 sm:p-5 rounded-xl border border-border bg-surface-2 text-text-muted text-sm leading-relaxed">
            <strong className="text-navy-800 font-semibold">Disclaimer: </strong>
            This article is for informational purposes only and does not
            constitute financial advice. Please perform your own research and
            due diligence before making any investment decisions.
          </div>
        )}

        {/* Author / LinkedIn */}
        <div className="mt-8 pt-6 border-t border-border flex items-center justify-between flex-wrap gap-4">
          <a
            href="https://www.linkedin.com/in/trevor-carnovsky/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 group"
            aria-label="Connect with Trevor Carnovsky on LinkedIn"
          >
            <span className="flex items-center justify-center w-10 h-10 rounded-lg bg-[#0077B5] text-white shadow-sm group-hover:bg-[#005f93] transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold text-navy-900 group-hover:text-[#0077B5] transition-colors">Trevor Carnovsky</p>
              <p className="text-xs text-slate-400">Connect on LinkedIn</p>
            </div>
          </a>

          {/* Back link */}
          <Link
            href="/articles"
            className="inline-flex items-center gap-2 text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M12 7H2M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back to all articles
          </Link>
        </div>
      </article>

      {/* Related Articles */}
      {related.length > 0 && (
        <section className="border-t border-border bg-surface-2 py-12 sm:py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2
              className="text-xl font-bold text-navy-900 mb-6 font-playfair"
            >
              More Research
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {related.map((a) => (
                <ArticleCard key={a.slug} article={a} />
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
