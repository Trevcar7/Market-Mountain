import type { NewsItem } from "@/lib/news-types";

/**
 * Centralized article patches — applied identically on:
 *   - GET /api/news (feed cards)
 *   - /news/[id] detail page
 *
 * Each patch matches on title keywords and overrides imageUrl, category, and/or
 * relatedTickers. First matching patch wins (break after match).
 *
 * Category-level fallback images are applied after patches for any article
 * still missing an imageUrl.
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
  imageUrl: string;
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
  // Warren / Pentagon / defense policy → US Capitol building; category → policy
  { test: /\bpentagon\b|\bwarren\b.*\b(?:defense|blacklist|anthropic)\b/i, imageUrl: "https://images.unsplash.com/photo-1501466044931-62695aada8e9?w=1200&q=80", category: "policy" },
  // Pfizer / pharma → markets category (not macro)
  { test: /\bpfizer\b|\bPFE\b|\bvalneva\b/i, imageUrl: "https://images.unsplash.com/photo-1770461846516-b7e5993a8e4f?w=1200&q=80", category: "markets" },
  // Netflix / streaming → Netflix on TV screen
  { test: /\bnetflix\b|\bNFLX\b/i, imageUrl: "https://images.unsplash.com/photo-1522869635100-9f4c5e86aa37?w=1200&q=80" },
  // Musk / Terafab / Tesla semiconductor → AI chip image; category → markets; strip irrelevant dollar chart
  { test: /\bterafab\b|\bmusk\b.*\b(?:chip|twitter|tesla)\b/i, imageUrl: "https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=1200&q=80", category: "markets", clearChartLabels: /dollar|dxy|dtwex/i },
  // SMCI / Super Micro — clear wrong NVDA chart + irrelevant Fed data; fix SMCI drop to actual -33%; category → markets; fix sentiment (indictment is negative, not positive)
  { test: /\bsuper micro\b|\bSMCI\b/i, imageUrl: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=1200&q=80", category: "markets", sentiment: "negative", clearChart: true, clearKeyData: true, marketImpactOverrides: [{ asset: "SMCI", change: "-33%", direction: "down" }] },
  // Nexstar / Tegna acquisition → TV news broadcast studio; fix tickers (was SPY/XLF/TLT, should be NXST/TGNA)
  { test: /\bnexstar\b|\btegna\b/i, imageUrl: "https://images.unsplash.com/photo-1495020689067-958852a7765e?w=1200&q=80", category: "markets", setTickers: ["NXST", "TGNA"] },
  // NVIDIA → official NVIDIA logo (green eye + wordmark); fix category to markets; strip bad AMD inline image
  { test: /\bnvidia\b|\bNVDA\b|\bjensen huang\b|\bblackwell\b|\bgeforce\b/i, imageUrl: "/images/nvidia-logo.png", category: "markets", clearInlineImage: true },
  // Bentley → luxury car (Continental GT logo)
  { test: /\bbentley\b/i, imageUrl: "https://images.unsplash.com/photo-1661683769067-1ebc0e7aa7b6?w=1200&q=80", relatedTickers: { TSLA: "VWAGY" } },
  // Humana / managed care → healthcare
  // Title fix: downgrade was about Medicare Advantage Stars ratings, not treasury yields
  { test: /\bhumana\b|\bmanaged care\b/i, imageUrl: "https://images.unsplash.com/photo-1638202993928-7267aad84c31?w=1200&q=80", title: "Bernstein Cuts Humana Target as Medicare Advantage Stars Pressure Weighs on Managed Care" },
  // Apple + IBM M&A → tech corporate; strip inline image
  { test: /\bibm\b.*\bapple\b|\bapple\b.*\bibm\b/i, imageUrl: "https://images.unsplash.com/photo-1722537273895-b35dfbd273ee?w=1200&q=80", clearInlineImage: true },
  // MLB / baseball / sports betting → baseball stadium (strip irrelevant macro data + inline image)
  // Title fix: CFTC signed an MOU (info-sharing agreement), not a regulatory approval
  { test: /\bmlb\b|\bbaseball\b|\bsports betting\b/i, imageUrl: "https://images.unsplash.com/photo-1471295253337-3ceaaedca402?w=1200&q=80", title: "MLB Partners With Polymarket Under CFTC Framework, Opening Door for Sports Prediction Markets", category: "markets", clearKeyData: true, clearInlineImage: true },
  // Meta content moderation / AI → Facebook + Messenger 3D icons (strip irrelevant macro data + wall street inline image)
  { test: /\bmeta\b.*\bcontent\b|\bmeta\b.*\bmoderation\b|\bmeta\b.*\bfacebook\b/i, imageUrl: "https://images.unsplash.com/photo-1611162618071-b39a2ec055fb?w=1200&q=80", category: "markets", clearKeyData: true, clearInlineImage: true },
  // OpenAI / AI acquisition → AI visualization (strip irrelevant GOOGL chart + treasury data); fix sentiment (M&A is neutral, not negative)
  { test: /\bopenai\b/i, imageUrl: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80", category: "markets", sentiment: "neutral", clearChart: true, clearKeyData: true },
  // Iran peace / oil retreat / equities rally (Mar 26) — comprehensive fact-check patch
  // Fixes: fabricated Iran Hormuz consent, wrong Fed date, overstated SPY, wrong sentiment/tickers, false-positive hallucination
  { test: /\boil retreat\b.*\biran\b|\biran peace signals\b/i,
    imageUrl: "https://images.unsplash.com/photo-1580561346873-4a76a13dce92?w=1200&q=80",
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
  // Iran + LNG / Qatar / strike → oil tanks with storm clouds; category → macro
  { test: /\biran\b.*\b(?:lng|qatar|strike|brent)\b/i, imageUrl: "https://images.unsplash.com/photo-1693847173071-bd6237101335?w=1200&q=80", category: "macro" },
  // Iran + oil / crude / consumer → industrial refinery; category → macro (distinct from LNG tanks above)
  { test: /\biran\b.*\b(?:oil|crude)\b/i, imageUrl: "https://images.unsplash.com/photo-1611273426858-450d8e3c9fce?w=1200&q=80", category: "macro" },
  // Iran + gilt / fiscal / UK → London skyline (UK finance); clear US yield keyData (article is about UK gilts, not US Treasuries); must come BEFORE general fallback
  { test: /\biran\b.*\b(?:gilt|fiscal|uk\b)/i, imageUrl: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=1200&q=80", category: "macro", clearKeyData: true },
  // Iran (general / Fed / inflation fallback) → oil refinery at night
  { test: /\biran\b/i, imageUrl: "https://images.unsplash.com/photo-1580561346873-4a76a13dce92?w=1200&q=80", category: "macro" },
  // Lululemon / athletic retail → yoga fitness class; strip inline image
  { test: /\blululemon\b/i, imageUrl: "https://images.unsplash.com/photo-1518611012118-696072aa579a?w=1200&q=80", clearInlineImage: true },
  // Stagflation / GDP collapse → stock market crash / red tape; strip foreign market inline image
  { test: /\bstagflation\b/i, imageUrl: "https://images.unsplash.com/photo-1579532537598-459ecdaf39cc?w=1200&q=80", clearInlineImage: true },
  // Novartis / pharma M&A → pharmaceutical lab; fix "October" → "March 2026" temporal hallucination in claims/takeaways
  { test: /\bnovartis\b|\bavidity\b/i, imageUrl: "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?w=1200&q=80", clearInlineImage: true,
    storyReplacements: [{ from: "committed $11 billion in bond financing in October", to: "committed $11 billion in bond financing in March 2026" }],
    keyTakeawayReplacements: [{ from: "raised $11 billion in October", to: "raised $11 billion in March 2026" }],
    verifiedClaimReplacements: [{ from: "in bond financing in October", to: "in bond financing in March 2026" }],
  },
  // Amazon → e-commerce/logistics; fix category to markets (not macro); fix sentiment (acquisition is positive, not negative)
  { test: /\bamazon\b|\bAMZN\b/i, imageUrl: "https://images.unsplash.com/photo-1523474253046-8cd2748b5fd2?w=1200&q=80", category: "markets", sentiment: "positive" },
  // Jio / Reliance IPO → India / emerging market
  { test: /\bjio\b|\breliance\b/i, imageUrl: "https://images.unsplash.com/photo-1468254095679-bbcba94a7066?w=1200&q=80" },
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

/** Category fallback: used when no patch matches and article has no imageUrl */
export const CATEGORY_FALLBACK_IMAGES: Record<string, string> = {
  macro:    "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1200&q=80",
  earnings: "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80",
  markets:  "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80",
  crypto:   "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80",
  policy:   "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=1200&q=80",
};

/** Apply all article patches to a single NewsItem (mutates nothing). */
export function applyArticlePatches(item: NewsItem): NewsItem {
  let patched = { ...item };
  const title = patched.title ?? "";

  for (const patch of ARTICLE_PATCHES) {
    if (patch.test.test(title)) {
      patched.imageUrl = patch.imageUrl;
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

  // Category fallback if still no image
  if (!patched.imageUrl) {
    patched.imageUrl = CATEGORY_FALLBACK_IMAGES[patched.category] ?? CATEGORY_FALLBACK_IMAGES.macro;
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
