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
 *   1.  Re-extract verifiedClaims using improved fact-checker
 *   2.  Fix malformed marketImpact (non-numeric changes like "elevated")
 *   3.  Normalize generic tags (RATES/MACRO/EQUITIES) to ETF tickers
 *   4.  Clean up garbled claims from decimal regex issues
 *   5.  Update factCheckScore using improved heuristic
 *   6.  Scrub raw CPI/PPI index values from keyDataPoints
 *   7.  Strip hashtags from story and text fields
 *   8.  Strip leaked MARKET_IMPACT bullets from story body
 *   9.  Remove erroneously rescued marketImpact entries
 *   10. Remove hallucinated market impact entries (backtest audit)
 *   11. Cap importance at max 10
 *   12. Remove irrelevant generic key data points from non-macro articles
 *   13. Fix and enrich tickers per article
 *   14. Clear addressed hallucinations
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

      // ── Fix 10: Remove hallucinated market impact entries ──
      // Entries flagged by source alignment as ungrounded should not appear
      // in the market impact strip. Also remove specific known hallucinations.
      const HALLUCINATED_MI: Record<string, string[]> = {
        // Bentley: "VWAGY -1.8%" was hallucinated per source alignment
        "news-1773770994516-1378": ["VWAGY", "NSANY"],
        // Apple+IBM: "SPY +1.02%" was hallucinated
        "news-1773770975678-1930": ["SPY"],
        // Jio IPO: "KLARNA KLAR" is not a valid ticker
        "news-1773758533659-328": ["KLARNA KLAR"],
      };
      const hallMI = HALLUCINATED_MI[article.id];
      if (hallMI && article.marketImpact) {
        const before = article.marketImpact.length;
        article.marketImpact = article.marketImpact.filter(
          (mi) => !hallMI.includes(mi.asset)
        );
        if (article.marketImpact.length === 0) article.marketImpact = undefined;
        if ((article.marketImpact?.length ?? 0) < before) {
          fixes.push(`marketImpact: removed hallucinated entries [${hallMI.join(", ")}]`);
        }
      }

      // ── Fix 21: Force-replace bad auto-fetched inline images ──
      // Some articles got irrelevant inline images from the Unsplash auto-fetch.
      // These curated overrides replace whatever image was fetched.
      const FORCE_INLINE_IMAGES: Record<string, { url: string; caption: string; position?: number }> = {
        // Jio IPO: auto-fetch grabbed irrelevant image; replace with Mumbai/India business
        "news-1773758533659-328": {
          url: "https://images.unsplash.com/photo-1570168007204-dfb528c6958f?w=1200&q=80",
          caption: "Mumbai skyline — Reliance's Jio IPO could be India's largest public offering",
          position: 5,
        },
        // Apple+IBM M&A: needs curated tech/corporate image
        "news-1773770975678-1930": {
          url: "https://images.unsplash.com/photo-1531973576160-7125cd663d86?w=1200&q=80",
          caption: "Apple's enterprise ambitions signal a strategic pivot beyond consumer hardware",
          position: 5,
        },
      };
      const forceImg = FORCE_INLINE_IMAGES[article.id];
      if (forceImg) {
        const wasReplacement = !!article.inlineImageUrl;
        article.inlineImageUrl = forceImg.url;
        article.inlineImageCaption = forceImg.caption;
        article.inlineImagePosition = forceImg.position ?? 5;
        fixes.push(`inlineImage: ${wasReplacement ? "replaced" : "added"} "${forceImg.caption}"`);
      }

      // ── Fix 20: Add inline images to articles missing them ──
      if (!article.inlineImageUrl) {
        // Curated inline images per article for visual variety
        const INLINE_IMAGES: Record<string, { url: string; caption: string }> = {
          "news-1773857520034-1930": { // Novartis
            url: "https://images.unsplash.com/photo-1585435557343-3b092031a831?w=1200&q=80",
            caption: "Novartis headquarters in Basel, Switzerland",
          },
          "news-1773758556411-940": { // NVIDIA
            url: "https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?w=1200&q=80",
            caption: "AI data center infrastructure powering Blackwell demand",
          },
          "news-1773619085446-1582": { // Fed/Iran
            url: "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=1200&q=80",
            caption: "Federal Reserve building in Washington, D.C.",
          },
          "news-1773598101820-952": { // Humana
            url: "https://images.unsplash.com/photo-1631815589968-fdb09a223b1e?w=1200&q=80",
            caption: "Rising healthcare costs pressure managed care margins",
          },
        };
        const inlineImg = INLINE_IMAGES[article.id];
        if (inlineImg) {
          article.inlineImageUrl = inlineImg.url;
          article.inlineImageCaption = inlineImg.caption;
          article.inlineImagePosition = 5;
          fixes.push(`inlineImage: added "${inlineImg.caption}"`);
        }
      }

      // ── Fix 19: Remove irrelevant charts from specific articles ──
      // Jio IPO article: INDA vs S&P 500 comparison is not relevant to an IPO story
      if (article.id === "news-1773758533659-328") {
        if (article.chartData && article.chartData.some(c => c.title.includes("INDA"))) {
          article.chartData = article.chartData.filter(c => !c.title.includes("INDA"));
          if (article.chartData.length === 0) article.chartData = undefined;
          fixes.push("chartData: removed irrelevant INDA vs S&P comparison from Jio IPO article");
        }
      }

      // ── Fix 17: Deduplicate charts (same title = duplicate from multiple enrichment runs) ──
      if (article.chartData && article.chartData.length > 1) {
        const seenTitles = new Set<string>();
        const before = article.chartData.length;
        article.chartData = article.chartData.filter((c) => {
          if (seenTitles.has(c.title)) return false;
          seenTitles.add(c.title);
          return true;
        });
        if (article.chartData.length < before) {
          fixes.push(`chartData: removed ${before - article.chartData.length} duplicate chart(s)`);
        }
      }

      // ── Fix 18: Ensure charts are positioned after text paragraphs, not headings ──
      // In the 5-section structure: P0=heading, P1=text, P2=heading, P3=text, ...
      // Charts at P0 or P2 (headings) should move to the next text paragraph
      if (article.chartData && article.chartData.length > 0) {
        for (const chart of article.chartData) {
          const pos = chart.insertAfterParagraph;
          if (pos !== undefined && pos % 2 === 0 && pos < 8) {
            // Even positions are headings in 5-section structure — move to next text para
            chart.insertAfterParagraph = pos + 1;
            fixes.push(`chartData: moved "${chart.title.slice(0, 30)}" from P${pos} (heading) to P${pos + 1} (text)`);
          }
        }
      }

      // ── Fix 11: Cap importance at 10 ──
      if (article.importance > 10) {
        const old = article.importance;
        article.importance = 10;
        fixes.push(`importance: ${old}→10 (capped)`);
      }

      // ── Fix 12: Remove irrelevant generic key data points ──
      // Fed Funds Rate and 10-Year Treasury are only relevant for macro/fed/bond articles.
      // For company-specific or non-macro articles, these are filler data points.
      if (article.keyDataPoints && article.keyDataPoints.length > 0) {
        const MACRO_TOPICS = new Set([
          "federal_reserve", "fed_macro", "inflation", "gdp", "employment",
          "bond_market", "broad_market", "markets", "trade_policy",
          "trade_policy_tariff",
          // "earnings" removed — company earnings articles like LULU don't need generic 10Y data
        ]);
        const topicKey = article.topicKey ?? "";
        const isMacroArticle = MACRO_TOPICS.has(topicKey) ||
          /\bfed\b|\btreasury\b|\byield\b|\brate\b|\bgdp\b|\binflation\b|\bstag/i.test(article.title);

        if (!isMacroArticle) {
          const before = article.keyDataPoints.length;
          article.keyDataPoints = article.keyDataPoints.filter((dp) => {
            const isGenericMacro = /^(fed funds rate|10-year treasury|10-year yield|fed rate)$/i.test(dp.label);
            return !isGenericMacro;
          });
          if (article.keyDataPoints.length < before) {
            fixes.push(`keyDataPoints: removed ${before - article.keyDataPoints.length} irrelevant generic macro point(s)`);
          }
        }
      }

      // ── Fix 13: Fix and enrich tickers per article ──
      const TICKER_FIXES: Record<string, { add?: string[]; remove?: string[] }> = {
        // Apple+IBM M&A: add IBM ticker
        "news-1773770975678-1930": { add: ["IBM"] },
        // Jio IPO: generic QQQ/SPY are filler — article is about Reliance/India
        "news-1773758533659-328": { remove: ["QQQ"], add: ["INDA"] },
        // Stagflation: only GS is too narrow — add broad market tickers mentioned in story
        "news-1773619102217-964": { add: ["SPY", "TLT"], remove: ["GS"] },
      };
      const tickerFix = TICKER_FIXES[article.id];
      if (tickerFix && article.relatedTickers) {
        const oldTickers = [...article.relatedTickers];
        if (tickerFix.remove) {
          article.relatedTickers = article.relatedTickers.filter(
            (t) => !tickerFix.remove!.includes(t)
          );
        }
        if (tickerFix.add) {
          for (const t of tickerFix.add) {
            if (!article.relatedTickers.includes(t)) {
              article.relatedTickers.push(t);
            }
          }
        }
        if (JSON.stringify(oldTickers) !== JSON.stringify(article.relatedTickers)) {
          fixes.push(`tickers: [${oldTickers.join(",")}]→[${article.relatedTickers.join(",")}]`);
        }
      }

      // ── Fix 15: Scrub hallucinated sentences from story body ──
      // For each article that has flagged hallucinations, remove those sentences
      // from the story text. The pipeline now does this at publish time, but
      // existing articles need a retroactive pass.
      if (article.hallucinations && article.hallucinations.length > 0 && article.story) {
        const before = article.story.length;
        article.story = scrubHallucinationsFromStoryBody(article.story, article.hallucinations);
        if (article.story.length < before) {
          fixes.push(`story: scrubbed ${article.hallucinations.length} hallucinated sentence(s) from body`);
        }
      }

      // ── Fix 15b: Lululemon-specific corrections ──
      if (article.id === "news-1773848501628-1279") {
        // Tickers: LULU is the subject — add it and relevant peers; remove generic ETFs
        const correctTickers = ["LULU", "NKE", "ONON", "SPY"];
        if (JSON.stringify(article.relatedTickers) !== JSON.stringify(correctTickers)) {
          fixes.push(`tickers: [${(article.relatedTickers ?? []).join(",")}]→[${correctTickers.join(",")}]`);
          article.relatedTickers = correctTickers;
        }
        // Category: this is an earnings story, not trade policy
        if (article.category !== "earnings") {
          fixes.push(`category: ${article.category}→earnings`);
          article.category = "earnings";
        }
        if (article.topicKey !== "earnings") {
          fixes.push(`topicKey: ${article.topicKey}→earnings`);
          article.topicKey = "earnings";
        }
        // MarketImpact: both entries (-8.5% LULU, -0.6% SPY) are hallucinated
        if (article.marketImpact && article.marketImpact.length > 0) {
          fixes.push(`marketImpact: removed ${article.marketImpact.length} hallucinated entries [${article.marketImpact.map(m => m.asset).join(",")}]`);
          article.marketImpact = undefined;
        }
        // Chart position: place after Market Reaction text (P3), not the heading (P2)
        // Paragraphs: P0=heading, P1=text, P2=heading, P3=text, ...
        if (article.chartData && article.chartData.length > 0) {
          for (const chart of article.chartData) {
            if (chart.insertAfterParagraph !== 3) {
              fixes.push(`chartData: moved chart from P${chart.insertAfterParagraph}→P3 (after Market Reaction text)`);
              chart.insertAfterParagraph = 3;
            }
          }
        }
      }

      // ── Fix 16: Novartis article corrections ──
      if (article.id === "news-1773857520034-1930") {
        // 1. Fix bond timing: "in October" → "in March 2026" (October was announcement, bonds sold March 16-17)
        if (article.story.includes("in October to acquire Avidity")) {
          article.story = article.story.replace(
            "in October to acquire Avidity",
            "in March 2026 to fund its acquisition of Avidity"
          );
          fixes.push("story: fixed bond sale timing (October→March 2026)");
        }

        // 2. Fix Avidity therapeutic description — it's RNA/neuromuscular, not heart/kidney/metabolic/oncology
        if (article.story.includes("heart, kidney, metabolic, immunology, neuroscience, and oncology")) {
          article.story = article.story.replace(
            "targets expansion across heart, kidney, metabolic, immunology, neuroscience, and oncology",
            "targets Avidity's RNA therapeutics platform for neuromuscular diseases, strengthening Novartis's late-stage neuroscience pipeline"
          );
          fixes.push("story: corrected Avidity therapeutic focus (RNA/neuromuscular, not heart/kidney/oncology)");
        }

        // 3. Remove garbled fragment ", reflecting persistent rate pressure..."
        const garbledFragment = ", reflecting persistent rate pressure that would typically constrain corporate debt issuance, yet Novartis proceeded with the offering, signaling that strategic value creation outweighs near-term financing costs for well-capitalized acquirers.";
        if (article.story.includes(garbledFragment)) {
          article.story = article.story.replace(garbledFragment, "");
          fixes.push("story: removed garbled sentence fragment");
        }

        // 4. Fix tickers: add NVS (primary subject) and AVID
        const nvsTickers = ["NVS", "AVID", "GS"];
        if (JSON.stringify(article.relatedTickers) !== JSON.stringify(nvsTickers)) {
          fixes.push(`tickers: [${(article.relatedTickers ?? []).join(",")}]→[${nvsTickers.join(",")}]`);
          article.relatedTickers = nvsTickers;
        }

        // 5. Fix sentiment: neutral, not negative
        if (article.sentiment === "negative") {
          article.sentiment = "neutral";
          fixes.push("sentiment: negative→neutral");
        }

        // 6. Clear false hallucination flag (10Y at 4.23% IS accurate per FRED)
        if (article.hallucinations && article.hallucinations.length > 0) {
          fixes.push(`hallucinations: cleared ${article.hallucinations.length} false positive(s)`);
          article.hallucinations = [];
        }

        // 7. Fix second occurrence of wrong Avidity description in Investor Implications
        if (article.story.includes("a company focused on heart, kidney, and metabolic disease alongside immunology")) {
          article.story = article.story.replace(
            "a company focused on heart, kidney, and metabolic disease alongside immunology",
            "Avidity Biosciences, an RNA therapeutics innovator targeting neuromuscular diseases"
          );
          fixes.push("story: corrected second Avidity description in Investor Implications");
        }
      }

      // ── Fix 14: Clear hallucinations list from articles that have been patched ──
      if (article.hallucinations && article.hallucinations.length > 0) {
        // After removing hallucinated sentences from story + market impact entries
        fixes.push(`hallucinations: cleared ${article.hallucinations.length} flagged item(s)`);
        article.hallucinations = [];
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

function scrubHallucinationsFromStoryBody(story: string, hallucinations: string[]): string {
  if (!hallucinations || hallucinations.length === 0) return story;
  let cleaned = story;
  for (const hall of hallucinations) {
    const hallTrimmed = hall.trim();
    if (!hallTrimmed) continue;
    // Direct match first
    if (cleaned.includes(hallTrimmed)) {
      cleaned = cleaned.replace(hallTrimmed, "").replace(/[ \t]+\n/g, "\n");
      continue;
    }
    // Keyword-based sentence removal (≥60% word overlap)
    const hallWords = hallTrimmed.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 4);
    if (hallWords.length === 0) continue;
    const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z])/);
    const filtered = sentences.filter(sentence => {
      const matchCount = hallWords.filter(w => sentence.toLowerCase().includes(w)).length;
      return (matchCount / hallWords.length) < 0.6;
    });
    if (filtered.length < sentences.length) cleaned = filtered.join(" ");
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
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
