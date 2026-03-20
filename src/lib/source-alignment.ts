/**
 * Source-Alignment Checker — Layer 2
 *
 * Verifies that claims in a synthesized article are grounded in the original
 * source articles it was built from. Uses Claude to perform a structured
 * comparison between the synthesis and its sources.
 *
 * This catches "hallucinations" — where the AI synthesis introduces claims,
 * statistics, or attributions that don't appear in any of the source material.
 *
 * How it works:
 *   1. Takes the synthesized article + its original source articles
 *   2. Asks Claude to identify the 5 most specific/verifiable claims
 *   3. For each claim, Claude checks whether ANY source supports it
 *   4. Returns per-claim grounding status + aggregate score
 *
 * Important: This is NOT the same as the data-fact-checker. The data-fact-checker
 * verifies against government APIs (ground truth). This checker verifies that
 * the AI didn't invent information beyond what sources reported.
 */

import { getAnthropicClient, CLAUDE_MODEL } from "./anthropic-client";
import type { NewsSource } from "./news-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceAlignmentClaim {
  claim: string;
  grounded: boolean;          // Claim found in at least one source?
  supportingSource?: string;  // Which source supported the claim (if any)
  explanation: string;        // Why the claim is/isn't grounded
}

export interface SourceAlignmentReport {
  claims: SourceAlignmentClaim[];
  score: number;              // 0–100 aggregate alignment score
  groundedCount: number;
  ungroundedCount: number;
  hallucinations: string[];   // List of claims not found in any source
}

// ---------------------------------------------------------------------------
// Formatter — build source context for Claude
// ---------------------------------------------------------------------------

function formatSourcesForVerification(
  sources: NewsSource[],
  sourceTexts: string[]
): string {
  const lines: string[] = [];

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const text = sourceTexts[i] ?? "";
    lines.push(`--- SOURCE ${i + 1}: ${src.source} ---`);
    lines.push(`Title: ${src.title}`);
    lines.push(`URL: ${src.url}`);
    if (text.trim()) {
      // Limit each source to ~1000 chars to stay within context budget
      lines.push(`Content: ${text.substring(0, 1000)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

/**
 * Run source-alignment verification on a synthesized article.
 *
 * @param story     The synthesized article body
 * @param title     The article headline
 * @param sources   The NewsSource[] from sourcesUsed
 * @param sourceTexts  The original article text snippets (from formatNewsForStorage)
 * @returns SourceAlignmentReport
 */
export async function runSourceAlignment(
  story: string,
  title: string,
  sources: NewsSource[],
  sourceTexts: string[]
): Promise<SourceAlignmentReport> {
  // If no sources available, can't verify alignment
  if (sources.length === 0 || sourceTexts.length === 0) {
    return {
      claims: [],
      score: 50, // Neutral — no sources to check against
      groundedCount: 0,
      ungroundedCount: 0,
      hallucinations: [],
    };
  }

  const client = getAnthropicClient();
  const sourceContext = formatSourcesForVerification(sources, sourceTexts);

  const prompt = `You are a fact-checking editor. I will give you a synthesized news article and the original source articles it was built from.

Your task: Identify the 5 most specific, verifiable factual claims in the SYNTHESIZED article, then check whether each claim is supported by at least one of the SOURCE articles.

A "claim" is a specific assertion of fact — a number, date, quote, event, or attribution. Do NOT select vague statements or opinions.

PRIORITY CLAIMS (check these FIRST, even if they aren't the "most specific"):
- Any claim about an acquisition, merger, partnership, or joint venture between named entities
- Any claim about a specific deal value (e.g., "$70 billion deal")
- Any claim about corporate bankruptcy, IPO, or executive appointment
- Any claim that two specific companies have a direct business relationship

These high-risk claims are the most common hallucination failure mode. For each one, verify that BOTH parties to the relationship appear IN THE SAME source article.

A claim about "Company A acquires Company B" is NOT grounded if:
- Company A appears in Source 1 (about a different deal)
- Company B appears in Source 2 (about a different deal)
- No single source mentions both companies in the same transaction

For each claim, determine:
- GROUNDED: The claim appears in or is directly supported by at least one source article
- UNGROUNDED: The claim does NOT appear in any source article (potential hallucination)

Respond in EXACTLY this format (5 claims, one per line):

CLAIM: [the specific claim from the synthesized article]
STATUS: GROUNDED or UNGROUNDED
SOURCE: [which source number supports it, or "NONE"]
REASON: [brief explanation]

CLAIM: [next claim]
STATUS: ...
SOURCE: ...
REASON: ...

(repeat for all 5 claims)

---

SYNTHESIZED ARTICLE:
Title: ${title}
${story.substring(0, 3000)}

---

SOURCE ARTICLES:
${sourceContext}`;

  try {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("\n");

    // Parse structured response
    const claims = parseAlignmentResponse(text);

    const groundedCount = claims.filter((c) => c.grounded).length;
    const ungroundedCount = claims.filter((c) => !c.grounded).length;
    const hallucinations = claims
      .filter((c) => !c.grounded)
      .map((c) => c.claim);

    // Score: heavily penalize ungrounded claims
    let score: number;
    if (claims.length === 0) {
      score = 60; // Parse failure — conservative neutral
    } else {
      const groundedRatio = groundedCount / claims.length;
      if (groundedRatio === 1) {
        score = 95; // All claims grounded — excellent
      } else if (groundedRatio >= 0.8) {
        score = 80; // Mostly grounded, minor issue
      } else if (groundedRatio >= 0.6) {
        score = 60; // Some ungrounded claims — concerning
      } else {
        score = 30; // Many ungrounded claims — likely hallucinating
      }
    }

    // Hard penalty: ungrounded corporate event claims (M&A, deals, partnerships)
    // are the highest-risk hallucination — cap score aggressively
    const CORPORATE_EVENT_RE = /\b(acquir|merger|merg|takeover|buyout|partner|joint venture|deal|purchase)\b/i;
    const hasUngroundedCorporateEvent = claims.some(
      (c) => !c.grounded && CORPORATE_EVENT_RE.test(c.claim)
    );
    if (hasUngroundedCorporateEvent) {
      score = Math.min(score, 40);
      console.warn(
        `[source-alignment] CORPORATE_EVENT_CAP=40 — ungrounded M&A/deal claim detected`
      );
    }

    console.log(
      `[source-alignment] Score=${score}: claims=${claims.length}, ` +
      `grounded=${groundedCount}, ungrounded=${ungroundedCount}`
    );
    for (const c of claims) {
      const icon = c.grounded ? "✓" : "✗";
      console.log(`  ${icon} "${c.claim.substring(0, 60)}..." — ${c.explanation}`);
    }

    return {
      claims,
      score,
      groundedCount,
      ungroundedCount,
      hallucinations,
    };
  } catch (err) {
    console.error(`[source-alignment] Claude verification failed: ${String(err)}`);
    // On failure, return neutral score — don't block articles due to API issues
    return {
      claims: [],
      score: 65,
      groundedCount: 0,
      ungroundedCount: 0,
      hallucinations: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Entity Relationship Verification — catches fabricated business relationships
// ---------------------------------------------------------------------------

export interface EntityRelationship {
  entityA: string;
  entityB: string;
  relationship: string;
  grounded: boolean;
  explanation: string;
}

export interface EntityRelationshipReport {
  relationships: EntityRelationship[];
  fabricatedCount: number;
  score: number; // 0–100: 100 = all grounded, 0 = all fabricated
}

/**
 * Verifies that entity-to-entity relationships in a synthesized article
 * actually appear in the source material. Uses Claude to extract the 3 most
 * important relationships and check whether BOTH entities + their described
 * interaction appear in the SAME single source article.
 *
 * This catches the highest-risk hallucination: merging separate company
 * events into a fabricated combined narrative (e.g., "Apple acquires IBM").
 */
export async function checkEntityRelationships(
  story: string,
  title: string,
  sources: NewsSource[],
  sourceTexts: string[]
): Promise<EntityRelationshipReport | null> {
  // Only run for articles that mention entity interactions
  const HAS_RELATIONSHIP_RE = /\b(acquir|merger|merg|partner|invest|deal|takeover|buyout|joint venture|purchase|launch|bid|appoint|sued|suing)\b/i;
  if (!HAS_RELATIONSHIP_RE.test(story) && !HAS_RELATIONSHIP_RE.test(title)) {
    return null; // No entity relationships to check
  }

  if (sources.length === 0 || sourceTexts.length === 0) return null;

  const client = getAnthropicClient();
  const sourceContext = formatSourcesForVerification(sources, sourceTexts);

  const entityPrompt = `You are a relationship fact-checker. I will give you a synthesized news article and its source articles.

Your task: Identify the 3 most important ENTITY-TO-ENTITY RELATIONSHIPS in the synthesized article.
A relationship is a specific interaction between two named entities (companies, people, organizations).

Examples of relationships:
- "Apple acquires IBM" (M&A)
- "JPMorgan downgrades Tesla" (analyst action)
- "Elon Musk invests in OpenAI" (investment)

For EACH relationship, check: Do BOTH entities AND their described relationship appear in the SAME single source article?

CRITICAL: A relationship is NOT grounded if Entity A appears in Source 1 and Entity B appears in Source 2 but they never appear TOGETHER in the same source with the described relationship.

If the article has fewer than 3 entity-to-entity relationships, list only the ones that exist.
If the article has NO entity-to-entity relationships, respond with: NO_RELATIONSHIPS

Respond in EXACTLY this format:

ENTITY_A: [first entity name]
ENTITY_B: [second entity name]
RELATIONSHIP: [the described interaction]
GROUNDED: YES or NO
SOURCE: [source number where BOTH entities appear together, or "NONE"]
REASON: [explanation]

(repeat for up to 3 relationships)

---

SYNTHESIZED ARTICLE:
Title: ${title}
${story.substring(0, 3000)}

---

SOURCE ARTICLES:
${sourceContext}`;

  try {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content: entityPrompt }],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("\n");

    if (text.includes("NO_RELATIONSHIPS")) {
      return { relationships: [], fabricatedCount: 0, score: 100 };
    }

    // Parse relationship blocks
    const relationships: EntityRelationship[] = [];
    const blocks = text.split(/(?=ENTITY_A:)/i).filter((b) => b.trim());

    for (const block of blocks) {
      const entityA = block.match(/ENTITY_A:\s*(.+)/i)?.[1]?.trim() ?? "";
      const entityB = block.match(/ENTITY_B:\s*(.+)/i)?.[1]?.trim() ?? "";
      const relationship = block.match(/RELATIONSHIP:\s*(.+)/i)?.[1]?.trim() ?? "";
      const grounded = /GROUNDED:\s*YES/i.test(block);
      const explanation = block.match(/REASON:\s*(.+)/i)?.[1]?.trim() ?? "";

      if (entityA && entityB) {
        relationships.push({ entityA, entityB, relationship, grounded, explanation });
      }
    }

    const fabricatedCount = relationships.filter((r) => !r.grounded).length;

    let score: number;
    if (relationships.length === 0) {
      score = 80; // Parse failure — conservative
    } else if (fabricatedCount === 0) {
      score = 100;
    } else {
      // Any fabricated relationship is severe
      score = Math.max(0, 100 - fabricatedCount * 40);
    }

    console.log(
      `[entity-relationships] Score=${score}: relationships=${relationships.length}, ` +
      `fabricated=${fabricatedCount}`
    );
    for (const r of relationships) {
      const icon = r.grounded ? "✓" : "✗";
      console.log(`  ${icon} "${r.entityA}" → "${r.entityB}" (${r.relationship}) — ${r.explanation}`);
    }

    return { relationships, fabricatedCount, score };
  } catch (err) {
    console.error(`[entity-relationships] Check failed: ${String(err)}`);
    return null; // Don't block on API failure
  }
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function parseAlignmentResponse(text: string): SourceAlignmentClaim[] {
  const claims: SourceAlignmentClaim[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let current: Partial<SourceAlignmentClaim> = {};

  for (const line of lines) {
    if (line.startsWith("CLAIM:")) {
      // If we have a pending claim, push it
      if (current.claim) {
        claims.push(finalizeClaim(current));
      }
      current = { claim: line.replace("CLAIM:", "").trim() };
    } else if (line.startsWith("STATUS:")) {
      const status = line.replace("STATUS:", "").trim().toUpperCase();
      current.grounded = status === "GROUNDED";
    } else if (line.startsWith("SOURCE:")) {
      const src = line.replace("SOURCE:", "").trim();
      if (src !== "NONE" && src.toLowerCase() !== "none") {
        current.supportingSource = src;
      }
    } else if (line.startsWith("REASON:")) {
      current.explanation = line.replace("REASON:", "").trim();
    }
  }

  // Push last claim
  if (current.claim) {
    claims.push(finalizeClaim(current));
  }

  return claims;
}

function finalizeClaim(partial: Partial<SourceAlignmentClaim>): SourceAlignmentClaim {
  return {
    claim: partial.claim ?? "",
    grounded: partial.grounded ?? false,
    supportingSource: partial.supportingSource,
    explanation: partial.explanation ?? "No explanation provided",
  };
}
