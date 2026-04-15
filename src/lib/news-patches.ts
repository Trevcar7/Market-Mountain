import type { NewsItem } from "@/lib/news-types";

/**
 * Centralized article patches — applied identically on:
 *   - GET /api/news (feed cards)
 *   - /news/[id] detail page
 *
 * Each patch matches on title keywords and overrides category, sentiment,
 * tickers, story text, and other data corrections.
 * First matching patch wins (break after match).
 */

interface MarketImpactOverride {
  asset: string;
  change: string;
  direction: "up" | "down" | "flat";
}

interface TextReplacement {
  from: string;
  to: string;
}

interface ArticlePatch {
  test: RegExp;
  title?: string;
  category?: string;
  sentiment?: "positive" | "negative" | "neutral";
  /** Map existing tickers to replacements (e.g. { TSLA: "VWAGY" }) */
  relatedTickers?: Record<string, string>;
  /** Replace the entire tickers array with these values */
  setTickers?: string[];
  marketImpactOverrides?: MarketImpactOverride[];
  clearChart?: boolean;
  /** Remove specific charts by matching their chartLabel or title (case-insensitive regex) */
  clearChartLabels?: RegExp;
  clearKeyData?: boolean;
  /** Clear inline image URL, caption, and position */
  clearInlineImage?: boolean;
  /** Find/replace in story body text */
  storyReplacements?: TextReplacement[];
  /** Find/replace in keyTakeaways array */
  keyTakeawayReplacements?: TextReplacement[];
  /** Find/replace in verifiedClaims array */
  verifiedClaimReplacements?: TextReplacement[];
  /** Clear all flagged hallucinations (use when flags are false positives) */
  clearHallucinations?: boolean;
}

export const ARTICLE_PATCHES: ArticlePatch[] = [
  // Anthropic / Claude / AI companies → category → markets
  { test: /\banthropic\b|\bclaude\b.*\bai\b|\banthropic\b.*\bban\b/i, category: "markets" },
  // Warren / Pentagon / defense policy → category → policy
  { test: /\bpentagon\b|\bwarren\b.*\b(?:defense|blacklist)\b/i, category: "policy" },
  // Pfizer / pharma → markets category (not macro)
  { test: /\bpfizer\b|\bPFE\b|\bvalneva\b/i, category: "markets" },
  // Meta data center / AI infrastructure → category → markets
  { test: /\bmeta\b.*\b(?:data center|el paso|infrastructure)\b/i, category: "markets" },
  // X / Musk advertising boycott lawsuit → category → markets
  { test: /\b(?:x's|twitter)\b.*\b(?:boycott|lawsuit|antitrust)\b|\badvertising boycott\b/i, category: "markets" },
  // Fink / BlackRock → category → markets
  { test: /\bfink\b|\bblackrock\b|\bBLK\b/i, category: "markets" },
  // Musk liable / fraud / Twitter verdict → category → markets
  { test: /\bmusk\b.*\b(?:liable|fraud|verdict)\b/i, category: "markets" },
  // Musk / Terafab / Tesla semiconductor → category → markets; strip irrelevant dollar chart
  { test: /\bterafab\b|\bmusk\b.*\b(?:chip|twitter|tesla)\b/i, category: "markets", clearChartLabels: /dollar|dxy|dtwex/i },
  // SMCI / Super Micro — fix SMCI drop to actual -33%; category → markets; fix sentiment (indictment is negative, not positive)
  { test: /\bsuper micro\b|\bSMCI\b/i, category: "markets", sentiment: "negative", clearKeyData: true, marketImpactOverrides: [{ asset: "SMCI", change: "-33%", direction: "down" }] },
  // Nexstar / Tegna acquisition → fix tickers (was SPY/XLF/TLT, should be NXST/TGNA)
  { test: /\bnexstar\b|\btegna\b/i, category: "markets", setTickers: ["NXST", "TGNA"] },
  // NVIDIA → fix category to markets; strip bad AMD inline image
  { test: /\bnvidia\b|\bNVDA\b|\bjensen huang\b|\bblackwell\b|\bgeforce\b/i, category: "markets", clearInlineImage: true },
  // Bentley → fix tickers
  { test: /\bbentley\b/i, relatedTickers: { TSLA: "VWAGY" } },
  // Humana / managed care
  // Title fix: downgrade was about Medicare Advantage Stars ratings, not treasury yields
  { test: /\bhumana\b|\bmanaged care\b/i, title: "Bernstein Cuts Humana Target as Medicare Advantage Stars Pressure Weighs on Managed Care" },
  // Apple + IBM M&A → strip inline image
  { test: /\bibm\b.*\bapple\b|\bapple\b.*\bibm\b/i, clearInlineImage: true },
  // MLB / baseball / sports betting → strip irrelevant macro data + inline image
  // Title fix: CFTC signed an MOU (info-sharing agreement), not a regulatory approval
  { test: /\bmlb\b|\bbaseball\b|\bsports betting\b/i, title: "MLB Partners With Polymarket Under CFTC Framework, Opening Door for Sports Prediction Markets", category: "markets", clearKeyData: true, clearInlineImage: true },
  // Meta content moderation / AI → strip irrelevant macro data + wall street inline image
  { test: /\bmeta\b.*\bcontent\b|\bmeta\b.*\bmoderation\b|\bmeta\b.*\bfacebook\b/i, category: "markets", clearKeyData: true, clearInlineImage: true },
  // OpenAI / AI acquisition → fix sentiment (M&A is neutral, not negative)
  { test: /\bopenai\b/i, category: "markets", sentiment: "neutral" },
  // Iran peace / oil retreat / equities rally (Mar 26) — comprehensive fact-check patch
  // Fixes: fabricated Iran Hormuz consent, wrong Fed date, overstated SPY, wrong sentiment/tickers, false-positive hallucination
  { test: /\boil retreat\b.*\biran\b|\biran peace signals\b/i,
    category: "macro",
    sentiment: "positive",
    setTickers: ["NKE", "ARM", "USO", "SPY"],
    clearHallucinations: true,
    marketImpactOverrides: [
      { asset: "SPY", change: "+0.4%", direction: "up" },
    ],
    storyReplacements: [
      // Fix 1: Iran did NOT agree to permit shipping — they rejected the plan
      { from: "with markets across time zones responding to the news that Iran had agreed to permit non-hostile shipping through the Strait of Hormuz. This specific concession suggested that both sides were moving toward a negotiated settlement rather than military escalation, fundamentally altering the risk calculus for energy markets and, by extension, equity valuations.",
        to: "with markets across time zones responding to reports that the U.S. had transmitted a 15-point peace framework to Iran via Pakistani intermediaries. Although Iran publicly rejected the proposal as unreasonable, the existence of a structured negotiation framework suggested diplomatic channels remained open, temporarily easing the risk calculus for energy markets and equity valuations." },
      // Fix 2: March 31 is Nike earnings, not an FOMC meeting — the March FOMC was March 17-18
      { from: "The March 31 Federal Reserve decision and the April CPI print are the next critical data points; if those readings confirm",
        to: "The next Federal Reserve decision in May and the April CPI print are the critical forward data points; if those readings confirm" },
    ],
    keyTakeawayReplacements: [
      // Fix overstated consensus shift claim based on misread Cramer source
      { from: "Wall Street's consensus has shifted from denial about market strength to acknowledgment that falling energy costs and de-escalation create a more favorable backdrop for earnings",
        to: "Falling energy costs and diplomatic signals have created a more favorable near-term backdrop for earnings, though Iran's rejection of the peace plan leaves the de-escalation trajectory uncertain" },
    ],
  },
  // Iran + LNG / Qatar / strike → category → macro
  { test: /\biran\b.*\b(?:lng|qatar|strike|brent)\b/i, category: "macro" },
  // Iran + oil / crude / consumer → category → macro
  { test: /\biran\b.*\b(?:oil|crude)\b/i, category: "macro" },
  // Iran + gilt / fiscal / UK → category → macro; clear US yield keyData (article is about UK gilts, not US Treasuries)
  { test: /\biran\b.*\b(?:gilt|fiscal|uk\b)/i, category: "macro", clearKeyData: true },
  // Iran (general / Fed / inflation fallback) → category → macro
  { test: /\biran\b/i, category: "macro" },
  // Lululemon / athletic retail → strip inline image
  { test: /\blululemon\b/i, clearInlineImage: true },
  // Stagflation / GDP collapse → strip foreign market inline image
  { test: /\bstagflation\b/i, clearInlineImage: true },
  // Novartis / pharma M&A → fix "October" → "March 2026" temporal hallucination
  { test: /\bnovartis\b|\bavidity\b/i, clearInlineImage: true,
    storyReplacements: [{ from: "committed $11 billion in bond financing in October", to: "committed $11 billion in bond financing in March 2026" }],
    keyTakeawayReplacements: [{ from: "raised $11 billion in October", to: "raised $11 billion in March 2026" }],
    verifiedClaimReplacements: [{ from: "in bond financing in October", to: "in bond financing in March 2026" }],
  },
  // Amazon → fix category to markets (not macro); fix sentiment (acquisition is positive, not negative)
  { test: /\bamazon\b|\bAMZN\b/i, category: "markets", sentiment: "positive" },
  // Qualcomm / AMD → category → markets
  { test: /\bqualcomm\b|\bQCOM\b|\bAMD\b/i, category: "markets" },
  // Palantir → category → markets
  { test: /\bpalantir\b|\bPLTR\b/i, category: "markets" },
  // Broadcom → category → markets
  { test: /\bbroadcom\b|\bAVGO\b/i, category: "markets" },
  // Warren Buffett / Berkshire Hathaway → category → markets
  { test: /\bbuffett\b|\bberkshire\b|\bBRK\b/i, category: "markets" },
  // CPI / Consumer Price Index → category → macro
  { test: /\bCPI\b|\bconsumer price/i, category: "macro" },
  // Japan / Nikkei / BOJ → category → macro
  { test: /\bjapan\b|\bnikkei\b|\bBOJ\b|\bbank of japan\b/i, category: "macro" },
];

/**
 * Normalize a change string like "-1.4297%" or "+0.2631%" to 2 decimal places.
 * Leaves non-percentage values (e.g. "+12bps", "-$3.40") untouched.
 */
function normalizeChange(change: string): string {
  const m = change.match(/^([+-]?)(\d+\.\d{3,})(%?)$/);
  if (m) {
    const sign = m[1];
    const num = parseFloat(m[2]).toFixed(2);
    return `${sign}${num}${m[3]}`;
  }
  return change;
}

/** Apply all article patches to a single NewsItem (mutates nothing). */
export function applyArticlePatches(item: NewsItem): NewsItem {
  let patched = { ...item };
  const title = patched.title ?? "";

  for (const patch of ARTICLE_PATCHES) {
    if (patch.test.test(title)) {
      if (patch.title) {
        patched.title = patch.title;
      }
      if (patch.category) {
        patched.category = patch.category as NewsItem["category"];
      }
      if (patch.sentiment) {
        patched.sentiment = patch.sentiment;
      }
      if (patch.setTickers) {
        patched.relatedTickers = patch.setTickers;
      } else if (patch.relatedTickers && patched.relatedTickers) {
        patched.relatedTickers = patched.relatedTickers.map(
          (t) => patch.relatedTickers![t] ?? t
        );
      }
      if (patch.clearChart) {
        patched.chartData = undefined;
      }
      if (patch.clearChartLabels && patched.chartData) {
        patched.chartData = patched.chartData.filter(
          (c) => !patch.clearChartLabels!.test(c.chartLabel ?? "") && !patch.clearChartLabels!.test(c.title ?? "")
        );
        if (patched.chartData.length === 0) patched.chartData = undefined;
      }
      if (patch.clearKeyData) {
        patched.keyDataPoints = undefined;
      }
      if (patch.clearInlineImage) {
        patched.inlineImageUrl = undefined;
        patched.inlineImageCaption = undefined;
        patched.inlineImagePosition = undefined;
      }
      if (patch.marketImpactOverrides && patched.marketImpact) {
        for (const override of patch.marketImpactOverrides) {
          const idx = patched.marketImpact.findIndex((mi) => mi.asset === override.asset);
          if (idx >= 0) {
            patched.marketImpact = [...patched.marketImpact];
            patched.marketImpact[idx] = { ...patched.marketImpact[idx], change: override.change, direction: override.direction };
          } else {
            patched.marketImpact = [...patched.marketImpact, { asset: override.asset, change: override.change, direction: override.direction }];
          }
        }
      }
      if (patch.clearHallucinations) {
        patched.hallucinations = undefined;
      }
      // Text replacements in story body
      if (patch.storyReplacements && patched.story) {
        for (const { from, to } of patch.storyReplacements) {
          patched.story = patched.story.split(from).join(to);
        }
      }
      // Text replacements in keyTakeaways
      if (patch.keyTakeawayReplacements && patched.keyTakeaways) {
        patched.keyTakeaways = patched.keyTakeaways.map((kt) => {
          let result = kt;
          for (const { from, to } of patch.keyTakeawayReplacements!) {
            result = result.split(from).join(to);
          }
          return result;
        });
      }
      // Text replacements in verifiedClaims
      if (patch.verifiedClaimReplacements && patched.verifiedClaims) {
        patched.verifiedClaims = patched.verifiedClaims.map((vc) => {
          let result = vc;
          for (const { from, to } of patch.verifiedClaimReplacements!) {
            result = result.split(from).join(to);
          }
          return result;
        });
      }
      break;
    }
  }

  // Normalize all percentage changes to 2 decimal places (e.g. "-1.4297%" → "-1.43%")
  if (patched.marketImpact) {
    patched.marketImpact = patched.marketImpact.map((mi) => ({
      ...mi,
      change: normalizeChange(mi.change),
    }));
  }
  if (patched.keyDataPoints) {
    patched.keyDataPoints = patched.keyDataPoints.map((kd) => ({
      ...kd,
      change: kd.change ? normalizeChange(kd.change) : kd.change,
    }));
  }

  return patched;
}
