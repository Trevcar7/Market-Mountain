/**
 * RSS Feed Fetcher & Normalizer
 *
 * Fetches XML from each configured RSS feed, parses items, and normalizes them
 * into the same `FinnhubArticle`-compatible shape used throughout the pipeline.
 * This means RSS articles flow through filterByAge, filterByRelevance,
 * deduplicateNews, groupRelatedArticles, and synthesis unchanged.
 *
 * Supports:
 *   - RSS 2.0  (standard <item> blocks)
 *   - Atom 1.0 (standard <entry> blocks)
 *
 * Graceful degradation:
 *   - Individual feed failures are logged and skipped (no pipeline abort)
 *   - Missing fields default to empty strings / 0 rather than throwing
 *   - Malformed XML falls back to empty results for that feed
 *
 * Source attribution:
 *   The `source` field in the returned FinnhubArticle is set to the canonical
 *   outlet name from RssSourceConfig (e.g. "Reuters", "Bloomberg"). This means
 *   the existing TIER_1_SOURCES / TIER_2_SOURCES matching in news.ts works
 *   without modification, and `sourcesUsed` in published NewsItems correctly
 *   names the originating outlet.
 */

import { FinnhubArticle } from "./news-types";
import { RssSourceConfig, getEnabledFeeds } from "./rss-config";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max milliseconds to wait for a single RSS feed response. */
const FETCH_TIMEOUT_MS = 8_000;

/** Max number of items to accept per feed (prevents enormous feeds from bloating the pool). */
const MAX_ITEMS_PER_FEED = 30;

/** RSS items older than this are ignored (matches the pipeline's age filter). */
const MAX_AGE_HOURS = 48;

// ── Minimal XML parser ────────────────────────────────────────────────────────

/**
 * Extract the text content between the first matching open/close tag pair.
 * Handles CDATA sections: <![CDATA[ ... ]]>
 * Returns empty string if the tag is not found.
 */
function extractTag(block: string, tag: string): string {
  // Match with optional attributes, e.g. <link rel="alternate" href="..."/>
  // Priority 1: <tag>...</tag>
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";

  let content = m[1].trim();

  // Strip CDATA wrapper: <![CDATA[...]]>
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(content);
  if (cdataMatch) {
    content = cdataMatch[1].trim();
  }

  return content;
}

/**
 * Extract the value of an XML attribute from a self-closing or opening tag.
 * e.g. extractAttr('<link href="https://..." rel="alternate"/>', 'href') → "https://..."
 */
function extractAttr(block: string, tag: string, attr: string): string {
  const tagRe = new RegExp(`<${tag}[^>]+>`, "i");
  const tagMatch = tagRe.exec(block);
  if (!tagMatch) return "";

  const attrRe = new RegExp(`${attr}="([^"]*)"`, "i");
  const attrMatch = attrRe.exec(tagMatch[0]);
  return attrMatch ? attrMatch[1].trim() : "";
}

/**
 * Split XML into individual <item> (RSS 2.0) or <entry> (Atom 1.0) blocks.
 */
function splitItems(xml: string): string[] {
  const items: string[] = [];

  // RSS 2.0
  const rssPattern = /<item[\s>][\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = rssPattern.exec(xml)) !== null) {
    items.push(m[0]);
  }

  if (items.length > 0) return items;

  // Atom 1.0 (fallback)
  const atomPattern = /<entry[\s>][\s\S]*?<\/entry>/gi;
  while ((m = atomPattern.exec(xml)) !== null) {
    items.push(m[0]);
  }

  return items;
}

/**
 * Decode common HTML entities found in RSS summaries/titles.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Strip HTML tags from a string (used to clean RSS summaries).
 */
function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Parse a pub-date string (RFC 2822 or ISO 8601) to a Unix timestamp (seconds).
 * Returns 0 if parsing fails.
 */
function parsePubDate(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.trim();
  try {
    const ts = new Date(cleaned).getTime();
    return isNaN(ts) ? 0 : Math.floor(ts / 1000);
  } catch {
    return 0;
  }
}

/**
 * Extract the best available URL from an RSS item block.
 * Tries in order: <link>, feedburner:origLink, atom:link href=alternate
 */
function extractUrl(block: string): string {
  // feedburner overrides
  const feedburner = extractTag(block, "feedburner:origLink");
  if (feedburner && feedburner.startsWith("http")) return feedburner;

  // Standard RSS <link> — in RSS 2.0 this is plain text between tags
  const link = extractTag(block, "link");
  if (link && link.startsWith("http")) return link;

  // Atom: <link rel="alternate" href="..."/>
  const atomHref = extractAttr(block, "link", "href");
  if (atomHref && atomHref.startsWith("http")) return atomHref;

  return "";
}

/**
 * Extract the best available image URL from an RSS item.
 * Tries: media:thumbnail, media:content, enclosure (image), og:image
 */
function extractImage(block: string): string {
  // <media:thumbnail url="..."/>
  const thumbRe = /<media:thumbnail[^>]+url="([^"]+)"/i;
  const thumbMatch = thumbRe.exec(block);
  if (thumbMatch) return thumbMatch[1];

  // <media:content url="..." type="image/..."/>
  const mediaRe = /<media:content[^>]+url="([^"]+)"[^>]+type="image/i;
  const mediaMatch = mediaRe.exec(block);
  if (mediaMatch) return mediaMatch[1];

  // <enclosure url="..." type="image/..."/>
  const enclosureRe = /<enclosure[^>]+url="([^"]+)"[^>]+type="image/i;
  const enclosureMatch = enclosureRe.exec(block);
  if (enclosureMatch) return enclosureMatch[1];

  return "";
}

/**
 * Parse a single RSS/Atom item block into a normalized object.
 */
interface ParsedRssItem {
  headline: string;
  summary: string;
  url: string;
  datetime: number;  // Unix timestamp (seconds)
  image: string;
  author: string;
}

function parseItem(block: string): ParsedRssItem {
  // Title
  const rawTitle =
    extractTag(block, "title") ||
    extractTag(block, "dc:title") ||
    "";
  const headline = decodeEntities(stripHtml(rawTitle)).trim();

  // Summary — prefer content:encoded → description → summary (Atom)
  const rawSummary =
    extractTag(block, "content:encoded") ||
    extractTag(block, "description") ||
    extractTag(block, "summary") ||
    "";
  // Limit summary to 400 chars to avoid huge CDATA blobs
  const summary = decodeEntities(stripHtml(rawSummary)).trim().substring(0, 400);

  // URL
  const url = extractUrl(block);

  // Publish date
  const rawDate =
    extractTag(block, "pubDate") ||
    extractTag(block, "published") ||
    extractTag(block, "updated") ||
    extractTag(block, "dc:date") ||
    "";
  const datetime = parsePubDate(rawDate);

  // Image
  const image = extractImage(block);

  // Author
  const author =
    extractTag(block, "author") ||
    extractTag(block, "dc:creator") ||
    "";

  return {
    headline,
    summary,
    url,
    datetime,
    image,
    author: decodeEntities(stripHtml(author)).trim(),
  };
}

// ── Per-feed fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch and parse a single RSS feed into FinnhubArticle-compatible objects.
 * Returns an empty array on any error (network, parse, timeout).
 */
async function fetchSingleFeed(
  config: RssSourceConfig
): Promise<FinnhubArticle[]> {
  const label = `[rss-fetch] "${config.name}"`;

  let xml: string;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(config.url, {
      signal: controller.signal,
      headers: {
        // Identify ourselves as a legitimate news aggregator bot
        "User-Agent": "Market-Mountain-NewsBot/1.0 (+https://market-mountain.com)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      // Disable Next.js fetch caching so we always get fresh content
      cache: "no-store",
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`${label} HTTP ${res.status} — skipping`);
      return [];
    }

    xml = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError = timeout; everything else = network/DNS failure
    if (msg.includes("abort") || msg.toLowerCase().includes("timeout")) {
      console.warn(`${label} Timed out after ${FETCH_TIMEOUT_MS}ms — skipping`);
    } else {
      console.warn(`${label} Fetch failed: ${msg} — skipping`);
    }
    return [];
  }

  // Parse items
  let itemBlocks: string[];
  try {
    itemBlocks = splitItems(xml);
  } catch (err) {
    console.warn(`${label} XML parse error — skipping:`, err);
    return [];
  }

  if (itemBlocks.length === 0) {
    console.warn(`${label} No items found in feed`);
    return [];
  }

  const cutoffSec = Math.floor(Date.now() / 1000) - MAX_AGE_HOURS * 3600;
  const results: FinnhubArticle[] = [];

  for (const block of itemBlocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const item = parseItem(block);

    // Must have headline and URL to be useful
    if (!item.headline || !item.url) continue;

    // Skip items without a parseable timestamp older than MAX_AGE_HOURS
    // (datetime === 0 means we couldn't parse the date — let filterByAge handle it)
    if (item.datetime > 0 && item.datetime < cutoffSec) continue;

    // Skip obviously non-http URLs
    if (!item.url.startsWith("http")) continue;

    results.push({
      headline: item.headline,
      summary:  item.summary,
      url:      item.url,
      source:   config.source,         // Canonical outlet name (e.g. "Reuters")
      datetime: item.datetime || Math.floor(Date.now() / 1000), // fallback to now
      category: config.category,
      image:    item.image || undefined,
      // Store author in the related array as a convention for downstream use
      related:  item.author ? [`author:${item.author}`] : undefined,
    });
  }

  console.log(`${label} Parsed ${results.length} items from ${itemBlocks.length} raw entries`);
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RssFetchStats {
  feedsAttempted: number;
  feedsSucceeded: number;
  feedsFailed: number;
  itemsTotal: number;
  /** Per-feed breakdown for logging */
  byFeed: Array<{ name: string; items: number; ok: boolean }>;
}

/**
 * Fetch all enabled RSS feeds in parallel and return normalized FinnhubArticle[].
 *
 * @param feeds  Optional override list (defaults to getEnabledFeeds()).
 * @returns      { articles, stats } — articles flow into the existing pipeline.
 */
export async function fetchRSSFeeds(
  feeds?: RssSourceConfig[]
): Promise<{ articles: FinnhubArticle[]; stats: RssFetchStats }> {
  const feedList = feeds ?? getEnabledFeeds();

  // Fetch all feeds concurrently; errors are handled per-feed
  const results = await Promise.allSettled(
    feedList.map((config) => fetchSingleFeed(config))
  );

  const all: FinnhubArticle[] = [];
  const byFeed: RssFetchStats["byFeed"] = [];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const config = feedList[i];

    if (result.status === "fulfilled") {
      const items = result.value;
      all.push(...items);
      byFeed.push({ name: config.name, items: items.length, ok: true });
      succeeded++;
    } else {
      byFeed.push({ name: config.name, items: 0, ok: false });
      failed++;
      console.warn(`[rss-fetch] "${config.name}" rejected:`, result.reason);
    }
  }

  // Deduplicate by URL across feeds (same article may appear in multiple feeds)
  const seenUrls = new Set<string>();
  const deduped: FinnhubArticle[] = [];
  for (const article of all) {
    const url = article.url ?? "";
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    deduped.push(article);
  }

  const stats: RssFetchStats = {
    feedsAttempted: feedList.length,
    feedsSucceeded: succeeded,
    feedsFailed: failed,
    itemsTotal: deduped.length,
    byFeed,
  };

  console.log(
    `[rss-fetch] Complete: ${succeeded}/${feedList.length} feeds OK, ` +
    `${deduped.length} unique items (${all.length - deduped.length} cross-feed duplicates removed)`
  );

  return { articles: deduped, stats };
}
