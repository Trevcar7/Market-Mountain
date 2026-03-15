/**
 * Co-Publication Validation Layer
 *
 * Validates batches of stories about to be published together, or stories
 * published within a short time window, for two classes of problems:
 *
 *   1. TOPICAL OVERLAP — prevents near-duplicate stories from occupying the top
 *      homepage positions simultaneously. Uses the same three-signal similarity
 *      model as NewsSection.tsx deduplication (topicKey, ticker overlap, title
 *      Jaccard), but with a slightly lower publish-time threshold (0.72 vs 0.75)
 *      to catch more conflicts before they reach the feed.
 *
 *   2. FACTUAL CONFLICT — prevents contradictory financial figures (oil price,
 *      inflation rate, Fed rate, Treasury yield, etc.) from appearing in stories
 *      published around the same time. Extracts numeric claims by entity and
 *      flags pairs that differ beyond entity-specific tolerance bands.
 *
 * Applies only to "near-simultaneous" stories: candidates in the same generation
 * cycle, or published within CO_PUB_WINDOW_HOURS of each other.
 * Stories outside this window are NOT affected — later follow-up coverage
 * (where figures may legitimately have changed) always publishes freely.
 *
 * When a topical or factual conflict is detected between two stories:
 *   - The lower-importance story is rejected from the publish batch.
 *   - If both have equal importance, the more recent story wins.
 *   - Already-published stories are never removed — only new candidates are
 *     rejected to maintain consistency with the existing feed.
 */

import { NewsItem } from "./news-types";

// ── Constants ────────────────────────────────────────────────────────────────

/** Hours within which two stories are considered "near-simultaneous". */
export const CO_PUB_WINDOW_HOURS = 6;

/**
 * Topical similarity threshold for publication.
 * Slightly more conservative than the display threshold (0.75) in NewsSection.tsx
 * — catching more conflicts before they enter the feed is preferable.
 */
const TOPICAL_THRESHOLD = 0.72;

// ── Topical similarity (mirrors NewsSection.tsx deduplication) ───────────────

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","as",
  "is","are","was","were","be","been","being","it","its","by","from","that",
  "this","these","those","will","would","could","should","may","might","has",
  "have","had","not","no","new","all","more","after","than","into","up","out",
  "s","do","did","over","said","say","says","their","they","we","us",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

function storySimilarity(a: NewsItem, b: NewsItem): number {
  let score = 0;

  // Signal 1 — topicKey cluster match (0.80)
  if (a.topicKey && b.topicKey && a.topicKey === b.topicKey) {
    score = Math.max(score, 0.80);
  }

  // Signal 2 — shared ticker overlap (up to 0.70)
  const tickersA = new Set(a.relatedTickers ?? []);
  const tickersB = b.relatedTickers ?? [];
  if (tickersA.size > 0 && tickersB.length > 0) {
    const shared = tickersB.filter((t) => tickersA.has(t)).length;
    if (shared > 0) {
      score = Math.max(score, (shared / Math.min(tickersA.size, tickersB.length)) * 0.70);
    }
  }

  // Signal 3 — title word overlap via Jaccard (up to 0.90)
  score = Math.max(score, jaccardSimilarity(a.title, b.title) * 0.90);

  return score;
}

// ── Factual consistency (numeric claim extraction) ───────────────────────────

interface NumericClaim {
  /** Canonical entity key (e.g. "wti_oil", "cpi_yoy"). */
  entity: string;
  /** Human-readable label (e.g. "WTI crude oil price"). */
  label: string;
  /** Unit symbol ("$", "%", "bp"). */
  unit: string;
  /** Extracted numeric value. */
  value: number;
}

/**
 * Tolerance map per financial entity.
 * "relative" = fraction of the average value (0.08 = 8%).
 * "absolute" = absolute difference in the same unit (percentage points for rates).
 *
 * Calibrated so that:
 *   - Oil: $92 vs $98.7 (6.7% diff) → conflict ✓  (tol 0.08 = 8% → actually 6.7% < 8%... hmm)
 *   Wait: |92 - 98.7| / ((92 + 98.7)/2) = 6.7 / 95.35 = 0.0702 → 7.0% > 6% tol → conflict ✓
 *   - CPI 2.4% vs 2.8%: |2.4 - 2.8| = 0.4pp = absolute tol 0.4pp → warn boundary (exactly at tol)
 *   - Fed funds rate: 0.25pp absolute (one Fed hike/cut increment)
 */
const ENTITY_TOLERANCE: Record<string, { type: "relative" | "absolute"; tol: number }> = {
  wti_oil:      { type: "relative", tol: 0.06 }, // 6%: $92 vs $98.7 = 7% diff → conflict
  brent_oil:    { type: "relative", tol: 0.06 },
  natural_gas:  { type: "relative", tol: 0.10 },
  bitcoin:      { type: "relative", tol: 0.08 },
  sp500:        { type: "relative", tol: 0.04 },
  nasdaq:       { type: "relative", tol: 0.04 },
  cpi_yoy:      { type: "absolute", tol: 0.40 }, // 0.4pp: 2.4% vs 2.8% → warn threshold
  core_cpi:     { type: "absolute", tol: 0.40 },
  core_pce:     { type: "absolute", tol: 0.40 },
  fed_rate:     { type: "absolute", tol: 0.25 }, // one Fed hike/cut increment
  treasury_10y: { type: "absolute", tol: 0.20 },
  dxy:          { type: "relative", tol: 0.03 }, // DXY: 3% relative
};

/** Extraction pattern groups: each group targets one financial entity. */
const EXTRACTION_PATTERNS: Array<{
  entity: string;
  label: string;
  unit: string;
  patterns: RegExp[];
}> = [
  {
    entity: "wti_oil",
    label: "WTI crude oil price",
    unit: "$",
    patterns: [
      /(?:wti|crude|oil)\s+(?:prices?\s+)?(?:at|near|toward|around|above|below|surged?\s+to|climbed?\s+to)?\s*\$?([\d.]+)\s*(?:per\s+barrel)?/gi,
      /\$\s*([\d.]+)\s*(?:per\s+barrel|\/bbl)/gi,
      /oil\s+near\s+\$?([\d.]+)/gi,
    ],
  },
  {
    entity: "cpi_yoy",
    label: "Headline CPI (year-over-year)",
    unit: "%",
    patterns: [
      /(?:headline\s+)?(?:cpi|consumer\s+price\s+index)\s+(?:rose|fell|climbed|declined|at|of|is|was|stands?\s+at|increased?\s+to|decreased?\s+to)?\s*([\d.]+)\s*%/gi,
      /(?:headline\s+)?inflation\s+(?:rose|fell|at|of|is|was|stands?\s+at)?\s*([\d.]+)\s*%/gi,
    ],
  },
  {
    entity: "core_cpi",
    label: "Core CPI (year-over-year)",
    unit: "%",
    patterns: [
      /core\s+(?:cpi|consumer\s+price)\s+(?:rose|fell|at|of|is|was|stands?\s+at)?\s*([\d.]+)\s*%/gi,
    ],
  },
  {
    entity: "core_pce",
    label: "Core PCE (year-over-year)",
    unit: "%",
    patterns: [
      /core\s+(?:pce|personal\s+consumption|inflation)\s+(?:rose|fell|at|of|is|was|stands?\s+at)?\s*([\d.]+)\s*%/gi,
      /core\s+inflation\s+rose\s+([\d.]+)\s*%\s+year.over.year/gi,
    ],
  },
  {
    entity: "fed_rate",
    label: "Federal funds rate",
    unit: "%",
    patterns: [
      /(?:fed(?:eral)?\s+funds|policy|benchmark)\s+rate\s+(?:at|of|is|was|stands?\s+at)?\s*([\d.]+)\s*%/gi,
      /(?:fed(?:eral)?\s+funds|policy|benchmark)\s+rate\s+(?:of|at)\s*([\d.]+)(?:\s*[-–]\s*([\d.]+))?\s*%/gi,
    ],
  },
  {
    entity: "treasury_10y",
    label: "10-year Treasury yield",
    unit: "%",
    patterns: [
      /10(?:\s*|-)?year\s+(?:treasury|t-note|note|bond)\s+(?:yield(?:s?)|at|of|is|was|stands?\s+at)?\s*([\d.]+)\s*%/gi,
      /(?:10y|10-year)\s+(?:yield|treasury)\s+(?:at|of|is|was)?\s*([\d.]+)\s*%/gi,
    ],
  },
  {
    entity: "bitcoin",
    label: "Bitcoin price",
    unit: "$",
    patterns: [
      /bitcoin\s+(?:at|near|above|below|surged?\s+to|climbed?\s+to|broke?)?\s*\$\s*([\d,]+)/gi,
      /btc\s+(?:at|near|above|below)?\s*\$\s*([\d,]+)/gi,
    ],
  },
];

function extractNumericClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  const lower = text.toLowerCase();

  for (const { entity, label, unit, patterns } of EXTRACTION_PATTERNS) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(lower)) !== null) {
        const raw = match[1].replace(/,/g, "");
        const value = parseFloat(raw);
        if (!isNaN(value) && value > 0) {
          // Deduplicate exact value for same entity within this text
          if (!claims.some((c) => c.entity === entity && c.value === value)) {
            claims.push({ entity, label, unit, value });
          }
        }
      }
    }
  }

  return claims;
}

function valuesConflict(entityKey: string, valueA: number, valueB: number): boolean {
  const tol = ENTITY_TOLERANCE[entityKey] ?? { type: "relative", tol: 0.10 };
  if (tol.type === "relative") {
    const avg = (valueA + valueB) / 2;
    return avg > 0 && Math.abs(valueA - valueB) / avg > tol.tol;
  } else {
    return Math.abs(valueA - valueB) > tol.tol;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CoPublicationIssue {
  type: "topical_overlap" | "factual_conflict";
  /** "reject" = lower-importance candidate dropped; "warn" = logged only. */
  severity: "reject" | "warn";
  storyAId: string;
  storyBId: string;
  description: string;
  similarityScore?: number;
  conflictDetails?: Array<{
    metric: string;
    valueA: number;
    valueB: number;
    unit: string;
  }>;
}

export interface CoPublicationResult {
  /** True if no candidates were rejected. */
  valid: boolean;
  issues: CoPublicationIssue[];
  /** IDs of candidates that should be dropped from the publish batch. */
  rejectedIds: string[];
  /** IDs of candidates with warnings (logged but still published). */
  warningIds: string[];
}

/**
 * Validate a batch of candidate stories against each other and against recently
 * published stories for topical overlap and factual consistency.
 *
 * @param candidates         Stories synthesized in this generation cycle (about to publish).
 * @param recentlyPublished  Stories already in the feed published within windowHours.
 * @param windowHours        "Near-simultaneous" time window (default: CO_PUB_WINDOW_HOURS).
 */
export function validateCoPublication(
  candidates: NewsItem[],
  recentlyPublished: NewsItem[],
  windowHours: number = CO_PUB_WINDOW_HOURS
): CoPublicationResult {
  const issues: CoPublicationIssue[] = [];
  const rejectedIdSet = new Set<string>();
  const warningIdSet = new Set<string>();

  const windowMs = windowHours * 60 * 60 * 1000;
  const now = Date.now();

  // Pre-extract numeric claims for all stories (candidates + recently published).
  const claimsByStoryId = new Map<string, NumericClaim[]>();
  for (const story of [...candidates, ...recentlyPublished]) {
    const fullText = [
      story.title,
      story.story,
      story.whyThisMatters ?? "",
      story.whatToWatchNext ?? "",
    ].join(" ");
    claimsByStoryId.set(story.id, extractNumericClaims(fullText));
  }

  const candidateIds = new Set(candidates.map((c) => c.id));

  for (let i = 0; i < candidates.length; i++) {
    const storyA = candidates[i];
    // Candidates that haven't published yet get the current time as their effective timestamp.
    const timeA = new Date(storyA.publishedAt).getTime();
    const effectiveTimeA = isNaN(timeA) ? now : timeA;

    const peers: NewsItem[] = [
      ...candidates.slice(i + 1),  // Other candidates in the same run
      ...recentlyPublished,         // Already-published within window
    ];

    for (const storyB of peers) {
      const timeB = new Date(storyB.publishedAt).getTime();
      const effectiveTimeB = isNaN(timeB) ? now : timeB;
      const timeDiff = Math.abs(effectiveTimeA - effectiveTimeB);

      // Only evaluate pairs within the time window
      if (timeDiff > windowMs) continue;

      // ── 1. Topical overlap check ──────────────────────────────────────────
      const similarity = storySimilarity(storyA, storyB);
      if (similarity >= TOPICAL_THRESHOLD) {
        // The lower-importance story is rejected. If importance is equal, the
        // more recently published story wins (keeps most-current coverage).
        const aLoses =
          storyA.importance < storyB.importance ||
          (storyA.importance === storyB.importance && effectiveTimeA <= effectiveTimeB);

        const loserId = aLoses ? storyA.id : storyB.id;
        const loserTitle = aLoses ? storyA.title : storyB.title;
        const loserIsCandidate = candidateIds.has(loserId);

        const winnerTitle = aLoses ? storyB.title : storyA.title;

        issues.push({
          type: "topical_overlap",
          severity: loserIsCandidate ? "reject" : "warn",
          storyAId: storyA.id,
          storyBId: storyB.id,
          description:
            `Topical overlap (score=${similarity.toFixed(2)} ≥ ${TOPICAL_THRESHOLD}): ` +
            `"${loserTitle}" conflicts with "${winnerTitle}" within ${windowHours}h window — ` +
            `${loserIsCandidate ? "lower-importance candidate rejected" : "warning only (existing story wins)"}`,
          similarityScore: similarity,
        });

        if (loserIsCandidate) rejectedIdSet.add(loserId);
        else warningIdSet.add(storyA.id);
      }

      // ── 2. Factual consistency check ──────────────────────────────────────
      const claimsA = claimsByStoryId.get(storyA.id) ?? [];
      const claimsB = claimsByStoryId.get(storyB.id) ?? [];

      const conflictDetails: NonNullable<CoPublicationIssue["conflictDetails"]> = [];

      for (const claimA of claimsA) {
        const claimB = claimsB.find((c) => c.entity === claimA.entity);
        if (!claimB) continue;

        if (valuesConflict(claimA.entity, claimA.value, claimB.value)) {
          conflictDetails.push({
            metric: claimA.label,
            valueA: claimA.value,
            valueB: claimB.value,
            unit: claimA.unit,
          });
        }
      }

      if (conflictDetails.length > 0) {
        const aLoses =
          storyA.importance < storyB.importance ||
          (storyA.importance === storyB.importance && effectiveTimeA <= effectiveTimeB);

        const loserId = aLoses ? storyA.id : storyB.id;
        const loserTitle = aLoses ? storyA.title : storyB.title;
        const loserIsCandidate = candidateIds.has(loserId);

        const conflictSummary = conflictDetails
          .map((d) => `${d.metric}: ${d.unit}${d.valueA} vs ${d.unit}${d.valueB}`)
          .join("; ");

        issues.push({
          type: "factual_conflict",
          severity: loserIsCandidate ? "reject" : "warn",
          storyAId: storyA.id,
          storyBId: storyB.id,
          description:
            `Factual conflict in "${loserTitle}": ${conflictSummary}. ` +
            `${loserIsCandidate ? "Candidate rejected to prevent contradictory figures in the feed." : "Warning: existing published story has conflicting figure."}`,
          conflictDetails,
        });

        if (loserIsCandidate) rejectedIdSet.add(loserId);
        else warningIdSet.add(storyA.id);
      }
    }
  }

  return {
    valid: rejectedIdSet.size === 0,
    issues,
    rejectedIds: [...rejectedIdSet],
    warningIds: [...warningIdSet],
  };
}
