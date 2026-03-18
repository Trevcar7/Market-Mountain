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

  const { searchParams } = new URL(req.url);
  const forceFactCheck = searchParams.get("force") === "true";

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  try {
    const collection = await kv.get<NewsCollection>("news");
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

        if (forceFactCheck || hasGarbledClaims || oldClaims.length === 0) {
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

      // ── Fix 6: Scrub raw CPI/PPI index values from keyDataPoints ──
      // Raw BLS index levels (e.g., "326.785", "333.242", "151.853") are meaningless to readers.
      // Remove any keyDataPoint whose label contains "CPI" or "PPI" and value looks like a raw index.
      if (article.keyDataPoints && article.keyDataPoints.length > 0) {
        const RAW_INDEX = /^\d{2,3}\.\d+$/; // e.g., "326.785", "333.242", "151.853"
        const before = article.keyDataPoints.length;
        article.keyDataPoints = article.keyDataPoints.filter((dp) => {
          const isInflationMetric = /cpi|ppi|inflation.*index/i.test(dp.label);
          const isRawIndex = RAW_INDEX.test(dp.value.replace(/[,$]/g, ""));
          return !(isInflationMetric && isRawIndex);
        });
        if (article.keyDataPoints.length < before) {
          fixes.push(`keyDataPoints: removed ${before - article.keyDataPoints.length} raw index value(s)`);
        }
      }

      // ── Fix 8: Strip leaked MARKET_IMPACT bullets from story body ──
      // Bullets like "• IWM -2.1% down" that appear before the first ## heading
      // are synthesis artifacts that leaked into the story body — strip them entirely.
      if (article.story) {
        const LEAKED_BULLET_RE = /^[•\-\*]\s+([A-Za-z0-9&. /]+)\s+([+\-]\d+[.,]?\d*\s*(?:%|bps|bp))\s*(up|down|flat)?\s*$/i;
        const lines = article.story.split("\n");
        const cleanedLines: string[] = [];
        let removedBullets = 0;

        for (const line of lines) {
          const t = line.trim();
          if (LEAKED_BULLET_RE.test(t)) {
            removedBullets++;
          } else {
            cleanedLines.push(line);
          }
        }

        if (removedBullets > 0) {
          // Collapse leading blank lines
          article.story = cleanedLines.join("\n").replace(/^\n+/, "");
          fixes.push(`story: removed ${removedBullets} leaked MARKET_IMPACT bullet(s) from body`);
        }
      }

      // ── Fix 9: Remove erroneously rescued marketImpact entries ──
      // The previous version of Fix 8 rescued leaked bullets into marketImpact.
      // For articles where marketImpact was originally null, those rescued entries
      // are unverified synthesis artifacts and should be removed.
      const ERRONEOUSLY_RESCUED: Record<string, string[]> = {
        "news-1773672499606-1279": ["IWM", "EWU"],
      };
      const toRemove = ERRONEOUSLY_RESCUED[article.id];
      if (toRemove && article.marketImpact) {
        const before = article.marketImpact.length;
        article.marketImpact = article.marketImpact.filter(
          (mi) => !toRemove.includes(mi.asset)
        );
        if (article.marketImpact.length === 0) article.marketImpact = undefined;
        if (article.marketImpact === undefined || article.marketImpact.length < before) {
          fixes.push(`marketImpact: removed erroneously rescued entries [${toRemove.join(", ")}]`);
        }
      }

      // ── Fix 7: Strip hashtags from story and text fields ──
      const stripHashtags = (s: string) => s.replace(/(?<!\w)#([A-Za-z]\w*)/g, "$1");
      if (article.story && /(?<!\w)#[A-Za-z]/.test(article.story)) {
        article.story = stripHashtags(article.story);
        fixes.push("story: stripped hashtags");
      }
      if (article.whyThisMatters && /(?<!\w)#[A-Za-z]/.test(article.whyThisMatters)) {
        article.whyThisMatters = stripHashtags(article.whyThisMatters);
        fixes.push("whyThisMatters: stripped hashtags");
      }
      if (article.whatToWatchNext && /(?<!\w)#[A-Za-z]/.test(article.whatToWatchNext)) {
        article.whatToWatchNext = stripHashtags(article.whatToWatchNext);
        fixes.push("whatToWatchNext: stripped hashtags");
      }
      if (article.secondOrderImplication && /(?<!\w)#[A-Za-z]/.test(article.secondOrderImplication)) {
        article.secondOrderImplication = stripHashtags(article.secondOrderImplication);
        fixes.push("secondOrderImplication: stripped hashtags");
      }
      if (article.keyTakeaways) {
        const hadHashtag = article.keyTakeaways.some((t) => /(?<!\w)#[A-Za-z]/.test(t));
        if (hadHashtag) {
          article.keyTakeaways = article.keyTakeaways.map(stripHashtags);
          fixes.push("keyTakeaways: stripped hashtags");
        }
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
      await kv.set("news", collection);
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
