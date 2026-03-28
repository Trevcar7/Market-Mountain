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
import TableOfContents from "@/components/TableOfContents";
import { parseHeadings } from "@/lib/parse-headings";
import ShareBar from "@/components/ShareBar";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return getAllArticleSlugs().map((slug) => ({ slug }));
}

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://marketmountainfinance.com";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) return {};
  return {
    title: article.title,
    description: article.excerpt,
    authors: [{ name: "Trevor Carnovsky", url: `${SITE_URL}/about` }],
    alternates: { canonical: `/post/${slug}` },
    openGraph: {
      title: article.title,
      description: article.excerpt,
      type: "article",
      publishedTime: article.date,
      authors: ["Trevor Carnovsky"],
      ...(article.coverImage
        ? { images: [{ url: article.coverImage, width: 1200, height: 630 }] }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.excerpt,
      creator: "@TrevorCarnovsky",
      ...(article.coverImage ? { images: [article.coverImage] } : {}),
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

  const tocHeadings = parseHeadings(article.content);

  const articleUrl = `${SITE_URL}/post/${slug}`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: article.title,
      description: article.excerpt,
      url: articleUrl,
      datePublished: article.date,
      ...(article.updated ? { dateModified: article.updated } : { dateModified: article.date }),
      author: {
        "@type": "Person",
        name: "Trevor Carnovsky",
        url: `${SITE_URL}/about`,
        jobTitle: "Equity Researcher & Investment Analyst",
        sameAs: ["https://www.linkedin.com/in/trevor-carnovsky/"],
      },
      publisher: {
        "@type": "Organization",
        name: "Market Mountain",
        url: SITE_URL,
        logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.svg` },
      },
      mainEntityOfPage: { "@type": "WebPage", "@id": articleUrl },
      ...(article.coverImage
        ? {
            image: {
              "@type": "ImageObject",
              url: article.coverImage.startsWith("http")
                ? article.coverImage
                : `${SITE_URL}${article.coverImage}`,
              width: 1200,
              height: 630,
            },
          }
        : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Articles", item: `${SITE_URL}/articles` },
        { "@type": "ListItem", position: 3, name: article.title },
      ],
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
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
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-[1.15] tracking-tight mb-4 font-playfair"
          >
            {article.title}
          </h1>

          {/* Dek / standfirst */}
          {article.excerpt && (
            <p className="text-white/60 text-lg sm:text-xl leading-relaxed font-normal max-w-[600px] mb-6">
              {article.excerpt}
            </p>
          )}

          {/* Author byline */}
          <div className="flex items-center gap-3 mt-2">
            <Image
              src="/images/trevor.jpg"
              alt="Trevor Carnovsky"
              width={40}
              height={40}
              className="rounded-full ring-2 ring-white/20"
            />
            <div>
              <Link href="/about" className="text-white/80 hover:text-white transition-colors text-sm font-medium">
                Trevor Carnovsky
              </Link>
              <p className="text-white/35 text-[11px]">Equity Researcher · CFA Research Challenge Champion</p>
            </div>
          </div>

          {/* Meta + Share */}
          <div className="flex flex-wrap items-center justify-between gap-y-3 mt-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-white/40 text-[11px] tracking-widest uppercase">
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
            <ShareBar url={articleUrl} title={article.title} />
          </div>
        </div>
      </div>

      {/* Accent divider */}
      <div className="h-1 bg-gradient-to-r from-navy-900 via-accent-500 to-navy-900" />

      {/* Article body — with optional ToC sidebar on lg+ screens */}
      <div className="bg-white">
      <div className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14 lg:flex lg:gap-14">
        {tocHeadings.length >= 3 && (
          <aside className="hidden lg:block w-44 shrink-0">
            <TableOfContents headings={tocHeadings} readTime={article.readTime} />
          </aside>
        )}
      <article className="min-w-0 flex-1 max-w-[680px]">
        <div className="prose prose-lg prose-slate max-w-none prose-drop-cap">
          <MDXRemote
            source={article.content}
            components={{ DCFHeatmap, BarChart, DataTable }}
            options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
          />
        </div>

        {/* Disclaimer */}
        {article.disclaimer !== false && (
          <div className={`mt-10 p-4 sm:p-5 rounded-xl text-text-muted text-sm leading-relaxed ${
            article.tags?.some(t => /equity research|price target/i.test(t))
              ? "border-l-4 border-l-amber-400 border border-amber-200/50 bg-amber-50/50"
              : "border border-border bg-surface-2"
          }`}>
            <strong className="text-navy-800 font-semibold">Disclaimer: </strong>
            This article is for informational purposes only and does not
            constitute financial advice. Please perform your own research and
            due diligence before making any investment decisions.
          </div>
        )}

        {/* Author card */}
        <div className="mt-8 pt-6 border-t border-border">
          <div className="flex items-start gap-4 mb-4">
            <Image
              src="/images/trevor.jpg"
              alt="Trevor Carnovsky"
              width={56}
              height={56}
              className="rounded-full ring-2 ring-border flex-shrink-0"
            />
            <div className="flex-1">
              <Link href="/about" className="text-base font-semibold text-navy-900 hover:text-accent-600 transition-colors">
                Trevor Carnovsky
              </Link>
              <p className="text-xs text-text-light mt-0.5">Equity Researcher · CFA Research Challenge Champion</p>
              <p className="text-sm text-text-muted mt-2 leading-relaxed">
                Independent equity researcher focused on fundamental analysis and long-term value creation.
                Data-driven, fundamental-first.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <a
                href="https://www.linkedin.com/in/trevor-carnovsky/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-[#0077B5] hover:text-[#005f93] font-medium transition-colors"
                aria-label="Connect with Trevor Carnovsky on LinkedIn"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
                LinkedIn
              </a>
              <Link href="/articles" className="text-sm text-text-muted hover:text-navy-900 transition-colors">
                All articles
              </Link>
            </div>
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
        </div>
      </article>
      </div>
      </div>

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
