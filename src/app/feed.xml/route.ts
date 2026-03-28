import { getAllArticles } from "@/lib/articles";

const SITE_URL = "https://marketmountainfinance.com";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const articles = getAllArticles();

  const items = articles.map((article) => {
    const pubDate = new Date(article.date).toUTCString();
    const link = `${SITE_URL}/post/${article.slug}`;
    const categories = (article.tags ?? [])
      .map((tag) => `    <category>${escapeXml(tag)}</category>`)
      .join("\n");

    return `  <item>
    <title>${escapeXml(article.title)}</title>
    <link>${link}</link>
    <guid isPermaLink="true">${link}</guid>
    <pubDate>${pubDate}</pubDate>
    <description>${escapeXml(article.excerpt)}</description>
    <author>trevor@marketmountainfinance.com (Trevor Carnovsky)</author>
${categories}
  </item>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Market Mountain | Independent Equity Research</title>
    <link>${SITE_URL}</link>
    <description>Data-driven equity analysis, macro commentary, and curated daily briefings by Trevor Carnovsky.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />
    <image>
      <url>${SITE_URL}/icon.png</url>
      <title>Market Mountain</title>
      <link>${SITE_URL}</link>
    </image>
${items.join("\n")}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600",
    },
  });
}
