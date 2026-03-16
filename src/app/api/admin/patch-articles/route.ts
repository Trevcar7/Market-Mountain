import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection, NewsItem, MarketImpactItem } from "@/lib/news-types";
import { extractClaimsFromStory, verifyClaims } from "@/lib/fact-checker";

export const maxDuration = 30;
export const runtime = "nodejs";

/**
 * POST /api/admin/patch-articles
 *
 * Retroactive cleanup for existing news articles in KV.
 * Fixes common quality issues in articles that were published before
 * code improvements were deployed:
 *
 *   1. Re-extract verifiedClaims using improved fact-checker
 *   2. Fix malformed marketImpact (non-numeric changes like "elevated")
 *   3. Normalize generic tags (RATES/MACRO/EQUITIES) to ETF tickers
 *   4. Clean up garbled claims from decimal regex issues
 *   5. Update factCheckScore using improved heuristic
 *
 * Protected by CRON_SECRET for security.
 */
export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  try {
    const collection = await kv.get<NewsCollection>("market-mountain-news");
    if (!collection || !collection.news || collection.news.length === 0) {
      return NextResponse.json({ message: "No articles to patch", patched: 0 });
    }

    const patchLog: Array<{ id: string; title: string; fixes: string[] }> = [];
    const patchedNews: NewsItem[] = [];

    for (const article of collection.news) {
      const fixes: string[] = [];

      // ── Fix 1: Re-extract and verify claims ──
      if (article.story) {
        const claims = extractClaimsFromStory(article.story);
        const { results, overallScore } = await verifyClaims(claims);

        // Only update if new claims are better quality
        const oldClaims = article.verifiedClaims ?? [];
        const newClaims = results
          .filter((r) => r.verified)
          .map((r) => cleanClaim(r.claim))
          .filter((c) => c.length > 20)
          .slice(0, 3);

        // Check if old claims are garbled (contain fragments or are too short)
        const hasGarbledClaims = oldClaims.some(
          (c) => c.length < 15 || /^\d+[.,]\d/.test(c) || /^[a-z]/.test(c)
        );

        if (hasGarbledClaims || oldClaims.length === 0) {
          article.verifiedClaims = newClaims;
          article.factCheckScore = overallScore;
          fixes.push(`claims: ${oldClaims.length}→${newClaims.length} (score: ${article.factCheckScore}→${overallScore})`);
        }
      }

      // ── Fix 2: Fix malformed marketImpact ──
      if (article.marketImpact && article.marketImpact.length > 0) {
        const VALID_FORMAT = /^[+\-]\d+[.,]?\d*\s*(%|bps|bp)$/i;
        const badItems = article.marketImpact.filter(
          (mi) => !VALID_FORMAT.test(mi.change.trim())
        );

        if (badItems.length > 0) {
          // Remove non-numeric marketImpact items
          const cleaned = article.marketImpact.filter((mi) =>
            VALID_FORMAT.test(mi.change.trim())
          );
          const removed = badItems.map((m) => `${m.asset}="${m.change}"`).join(", ");
          article.marketImpact = cleaned.length > 0 ? cleaned : undefined;
          fixes.push(`marketImpact: removed malformed [${removed}]`);
        }

        // Normalize asset names
        if (article.marketImpact) {
          const NORM: Record<string, string> = {
            OIL: "WTI", CRUDE: "WTI", "CRUDE OIL": "WTI",
            GOLD: "GLD", SILVER: "SLV", BITCOIN: "BTC", ETHEREUM: "ETH",
            DOLLAR: "DXY", "DOLLAR INDEX": "DXY", USD: "DXY",
            "S&P 500": "SPY", "S&P": "SPY", NASDAQ: "QQQ",
            DOW: "DIA", "DOW JONES": "DIA",
            "10Y YIELD": "10Y", TREASURY: "TLT",
          };
          let normalized = false;
          article.marketImpact = article.marketImpact.map((mi) => {
            const newAsset = NORM[mi.asset.toUpperCase()];
            if (newAsset && newAsset !== mi.asset) {
              normalized = true;
              return { ...mi, asset: newAsset };
            }
            return mi;
          });
          if (normalized) fixes.push("marketImpact: normalized asset names");

          // Deduplicate by asset
          const seen = new Set<string>();
          const deduped: MarketImpactItem[] = [];
          for (const mi of article.marketImpact) {
            if (!seen.has(mi.asset)) {
              seen.add(mi.asset);
              deduped.push(mi);
            }
          }
          if (deduped.length < article.marketImpact.length) {
            article.marketImpact = deduped;
            fixes.push("marketImpact: removed duplicates");
          }
        }
      }

      // ── Fix 3: Normalize generic tags ──
      if (article.relatedTickers) {
        const GENERIC_TAG_MAP: Record<string, string> = {
          RATES: "TLT", MACRO: "SPY", EQUITIES: "SPY",
          BONDS: "TLT", "FIXED INCOME": "TLT",
          OIL: "WTI", DOLLAR: "DXY",
        };
        const oldTags = [...article.relatedTickers];
        article.relatedTickers = article.relatedTickers.map((tag) => {
          const upper = tag.toUpperCase();
          return GENERIC_TAG_MAP[upper] ?? tag;
        });
        // Deduplicate
        article.relatedTickers = [...new Set(article.relatedTickers)];
        if (JSON.stringify(oldTags) !== JSON.stringify(article.relatedTickers)) {
          fixes.push(`tags: [${oldTags.join(",")}]→[${article.relatedTickers.join(",")}]`);
        }
      }

      // ── Fix 4: Add section headings if missing ──
      if (article.story && !/^## /m.test(article.story)) {
        const paragraphs = article.story.split(/\n\n+/).filter((p) => p.trim().length > 30);
        if (paragraphs.length >= 5) {
          const SECTION_TITLES = [
            "## Event Summary",
            "## Market Reaction",
            "## Macro Context",
            "## Investor Implications",
            "## What to Watch",
          ];
          const newParagraphs = paragraphs.map((p, i) => {
            if (i < SECTION_TITLES.length) {
              return `${SECTION_TITLES[i]}\n\n${p}`;
            }
            return p;
          });
          article.story = newParagraphs.join("\n\n");
          fixes.push("story: added 5 section headings");
        }
      }

      // ── Fix 5: Ensure wordCount is set ──
      if (!article.wordCount && article.story) {
        article.wordCount = article.story.trim().split(/\s+/).length;
        fixes.push(`wordCount: set to ${article.wordCount}`);
      }

      if (fixes.length > 0) {
        patchLog.push({ id: article.id, title: article.title, fixes });
      }
      patchedNews.push(article);
    }

    // Save patched collection back to KV
    if (patchLog.length > 0) {
      collection.news = patchedNews;
      collection.lastUpdated = new Date().toISOString();
      await kv.set("market-mountain-news", collection);
    }

    return NextResponse.json({
      message: `Patched ${patchLog.length} of ${collection.news.length} articles`,
      patched: patchLog.length,
      details: patchLog,
    });
  } catch (error) {
    console.error("[patch-articles] Error:", error);
    return NextResponse.json(
      { error: "Patch failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

function cleanClaim(claim: string): string {
  let clean = claim.trim();
  clean = clean.replace(/^(HEADLINE|KEY_TAKEAWAYS|WHY_MATTERS|SECOND_ORDER|WHAT_WATCH|MARKET_IMPACT):\s*/gi, "");
  clean = clean.replace(/^## /, "");
  clean = clean.replace(/^[•\-\*]\s*/, "");
  if (clean.length > 0) {
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  if (clean.length > 0 && !/[.!?]$/.test(clean)) {
    clean += ".";
  }
  return clean;
}
