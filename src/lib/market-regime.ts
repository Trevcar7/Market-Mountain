/**
 * Market Regime Detection + Macro Signal Layer
 *
 * Detects the current market regime from incoming news topic groups and boosts
 * the importance scores of stories that are directly relevant to the active regime.
 *
 * Four regime axes:
 *   macro_event   — CPI, NFP, FOMC, GDP release day → +2 importance boost
 *   earnings      — Earnings season, quarterly results → +1 importance boost
 *   geopolitical  — Elevated geopolitical risk → +1 importance boost
 *   commodity     — Energy/commodity supply shock → +1 importance boost
 *
 * Usage in the fetch-news pipeline (step 4d.5-pre):
 *   const regime = detectMarketRegime(afterCategoryCap);
 *   applyRegimeBoosts(afterCategoryCap, regime);
 *   // Then run diversification sort + importance floor as normal
 */

export type RegimeSignal =
  | "macro_event"
  | "earnings"
  | "geopolitical"
  | "commodity"
  | "none";

export interface MarketRegime {
  /** The single most-impactful signal detected across all groups */
  dominant: RegimeSignal;
  /** All signals detected (may be multiple simultaneously) */
  activeSignals: RegimeSignal[];
  /** Per-topic importance boosts to apply (topicKey → boost amount) */
  importanceBoosts: Map<string, number>;
  /** Human-readable description for logging */
  description: string;
}

// ---------------------------------------------------------------------------
// Pattern libraries
// ---------------------------------------------------------------------------

const MACRO_EVENT_PATTERNS: RegExp[] = [
  /\b(cpi|consumer\s*price\s*index|core\s*cpi)\b/i,
  /\b(pce|personal\s*consumption\s*expenditure)\b/i,
  /\b(nfp|non.?farm\s*payroll|jobs\s*report|employment\s*report|payroll\s*data)\b/i,
  /\b(fomc|federal\s*open\s*market|fed\s*decision|rate\s*decision|rate\s*hike|rate\s*cut)\b/i,
  /\b(federal\s*reserve\s*meeting|powell\s*speech|fed\s*statement)\b/i,
  /\b(gdp\s*report|gdp\s*growth|economic\s*output|recession\s*risk)\b/i,
  /\b(ppi|producer\s*price|import\s*price|inflation\s*data|inflation\s*report)\b/i,
  /\b(retail\s*sales|industrial\s*production|ism\s*manufacturing|ism\s*services)\b/i,
];

const EARNINGS_PATTERNS: RegExp[] = [
  /\b(earnings\s*beat|earnings\s*miss|quarterly\s*results|eps\s*beat|eps\s*miss)\b/i,
  /\b(revenue\s*beat|guidance\s*raised|guidance\s*cut|outlook\s*raised|outlook\s*lowered)\b/i,
  /\b(q[1-4]\s*\d{4}|fiscal\s*q[1-4]|full.year\s*guidance)\b/i,
  /\b(earnings\s*season|reporting\s*season|results\s*season)\b/i,
];

const GEOPOLITICAL_PATTERNS: RegExp[] = [
  /\b(iran|russia|china\s*tensions|ukraine|taiwan\s*strait|north\s*korea|middle\s*east)\b/i,
  /\b(tariff|trade\s*war|trade\s*dispute|sanction|embargo|export\s*control)\b/i,
  /\b(military\s*conflict|armed\s*conflict|escalation|ceasefire|invasion)\b/i,
  /\b(geopolitical\s*risk|geopolitical\s*tension|global\s*tension)\b/i,
];

const COMMODITY_PATTERNS: RegExp[] = [
  /\b(oil\s*spike|crude\s*surge|wti\s*price|brent\s*crude|opec\s*cut|opec\+)\b/i,
  /\b(supply\s*shock|energy\s*crisis|nat(?:ural)?\s*gas\s*shortage|lng\s*shortage)\b/i,
  /\b(commodity\s*shock|commodity\s*surge|wheat\s*price|copper\s*price|gold\s*spike)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

const SIGNAL_DESCRIPTIONS: Record<RegimeSignal, string> = {
  macro_event: "Macro data release active — CPI/NFP/FOMC signals → +2 importance",
  earnings: "Earnings season active — quarterly results driving coverage → +1 importance",
  geopolitical: "Geopolitical risk elevated — global tensions detected → +1 importance",
  commodity: "Commodity shock regime — energy/resource disruption → +1 importance",
  none: "Normal market regime — no signal override active",
};

const SIGNAL_BOOSTS: Record<RegimeSignal, number> = {
  macro_event: 2,
  earnings: 1,
  geopolitical: 1,
  commodity: 1,
  none: 0,
};

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

interface GroupLike {
  topic: string;
  articles: Array<unknown>;
}

/**
 * Detect the active market regime from a set of topic groups.
 * Returns regime metadata including per-topic importance boosts.
 */
export function detectMarketRegime(groups: GroupLike[]): MarketRegime {
  const importanceBoosts = new Map<string, number>();

  for (const g of groups) {
    const groupText = [
      g.topic,
      ...g.articles.map((a) => {
        const art = a as Record<string, unknown>;
        return String(art.headline ?? art.title ?? "");
      }),
    ].join(" ");

    // Find the highest-priority signal for this group
    let topBoost = 0;

    if (matchesAny(groupText, MACRO_EVENT_PATTERNS)) {
      topBoost = Math.max(topBoost, SIGNAL_BOOSTS.macro_event);
    }
    if (matchesAny(groupText, EARNINGS_PATTERNS)) {
      topBoost = Math.max(topBoost, SIGNAL_BOOSTS.earnings);
    }
    if (matchesAny(groupText, GEOPOLITICAL_PATTERNS)) {
      topBoost = Math.max(topBoost, SIGNAL_BOOSTS.geopolitical);
    }
    if (matchesAny(groupText, COMMODITY_PATTERNS)) {
      topBoost = Math.max(topBoost, SIGNAL_BOOSTS.commodity);
    }

    if (topBoost > 0) {
      importanceBoosts.set(g.topic, topBoost);
    }
  }

  // Determine active signals across all groups
  const allText = groups
    .flatMap((g) => [
      g.topic,
      ...g.articles.map((a) => {
        const art = a as Record<string, unknown>;
        return String(art.headline ?? art.title ?? "");
      }),
    ])
    .join(" ");

  const activeSignals: RegimeSignal[] = [];
  if (matchesAny(allText, MACRO_EVENT_PATTERNS)) activeSignals.push("macro_event");
  if (matchesAny(allText, EARNINGS_PATTERNS)) activeSignals.push("earnings");
  if (matchesAny(allText, GEOPOLITICAL_PATTERNS)) activeSignals.push("geopolitical");
  if (matchesAny(allText, COMMODITY_PATTERNS)) activeSignals.push("commodity");

  const dominant: RegimeSignal = activeSignals[0] ?? "none";

  const description =
    activeSignals.length > 0
      ? activeSignals.map((s) => SIGNAL_DESCRIPTIONS[s]).join(" | ")
      : SIGNAL_DESCRIPTIONS.none;

  return { dominant, activeSignals, importanceBoosts, description };
}

/**
 * Apply regime-based importance boosts to groups in-place.
 * Logs each boost for observability. Returns the number of groups boosted.
 */
export function applyRegimeBoosts(
  groups: Array<{ topic: string; importance: number }>,
  regime: MarketRegime,
  log: (msg: string) => void = console.log
): number {
  if (regime.activeSignals.length === 0) return 0;

  let boosted = 0;
  for (const g of groups) {
    const boost = regime.importanceBoosts.get(g.topic) ?? 0;
    if (boost > 0) {
      log(
        `[market-regime] Importance boost: "${g.topic}" +${boost} ` +
          `(${g.importance} → ${g.importance + boost}) — ${regime.dominant} signal`
      );
      g.importance += boost;
      boosted++;
    }
  }

  return boosted;
}
