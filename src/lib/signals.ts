/**
 * Market Signal Engine
 *
 * Uses Claude Haiku to generate 3–5 actionable market signals based on today's
 * published news. Signals are concise directional views for investors:
 *   - direction: bullish | bearish | neutral
 *   - asset: what the signal applies to
 *   - timeframe: near-term window
 *   - confidence: how strongly the signal is supported
 *
 * Generated signals are cached in Redis KV for 1 hour.
 */

import { getAnthropicClient, CLAUDE_MODEL } from "./anthropic-client";
import { MarketSignal, SignalsCollection, NewsItem } from "./news-types";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SIGNALS_SYSTEM_PROMPT = `You are a market strategist at a financial research firm.
Your job is to distill today's financial news into 3–5 clear, actionable market signals for investors.

A signal is a directional view on a specific asset or market sector, supported by evidence from the news.

Output exactly 3–5 signals in this format — one block per signal, separated by blank lines:

SIGNAL:
DIRECTION: bullish | bearish | neutral
ASSET: [specific asset or index, e.g. "S&P 500", "Oil", "Bitcoin", "10-Year Treasury", "Tech Sector"]
TIMEFRAME: [e.g. "Near-term (1–2 weeks)", "Short-term (2–4 weeks)", "Medium-term (1–3 months)"]
CONFIDENCE: high | medium | low
STATEMENT: [One clear sentence explaining the signal and why it's supported by today's news]

Rules:
- Each signal must be grounded in the news provided — no fabrication
- Keep STATEMENT under 30 words
- Cover different assets/sectors — do not generate 3 signals on the same topic
- Be direct and specific: "Oil faces downward pressure" not "Oil may possibly decline"
- Confidence is "high" only when multiple sources corroborate the signal
- Always write "U.S." (with periods) when referring to the United States — never "US"`;

function buildSignalsPrompt(stories: NewsItem[]): string {
  const summaries = stories
    .slice(0, 8) // Use up to 8 most recent stories
    .map(
      (s, i) =>
        `${i + 1}. [${s.category.toUpperCase()}] ${s.title}\n   ${s.whyThisMatters ?? s.story.split(".")[0] + "."}`
    )
    .join("\n\n");

  return `Today's Market Mountain news (${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}):

${summaries}

Generate 3–5 market signals based on these developments.`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseSignals(raw: string): MarketSignal[] {
  const signals: MarketSignal[] = [];
  const blocks = raw.split(/\n\s*\n/).filter((b) => b.includes("DIRECTION:"));

  for (const block of blocks) {
    try {
      const direction = extractField(block, "DIRECTION") as MarketSignal["direction"];
      const asset = extractField(block, "ASSET");
      const timeframe = extractField(block, "TIMEFRAME");
      const confidence = extractField(block, "CONFIDENCE") as MarketSignal["confidence"];
      const statement = extractField(block, "STATEMENT");

      if (!asset || !statement || !direction) continue;

      const validDirections: MarketSignal["direction"][] = ["bullish", "bearish", "neutral"];
      const validConfidences: MarketSignal["confidence"][] = ["high", "medium", "low"];

      signals.push({
        id: `signal-${Date.now()}-${signals.length}`,
        signal: statement,
        direction: validDirections.includes(direction) ? direction : "neutral",
        asset,
        timeframe: timeframe || "Near-term",
        confidence: validConfidences.includes(confidence) ? confidence : "medium",
        generatedAt: new Date().toISOString(),
      });
    } catch {
      // Skip malformed blocks
    }
  }

  return signals.slice(0, 5);
}

function extractField(block: string, field: string): string {
  const match = block.match(new RegExp(`${field}:\\s*(.+)`));
  return match?.[1]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate market signals from a set of published news stories.
 * Returns a SignalsCollection with 1-hour validity window.
 * Returns null if Anthropic API key is not configured.
 */
export async function generateMarketSignals(
  stories: NewsItem[]
): Promise<SignalsCollection | null> {
  if (stories.length === 0) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[signals] ANTHROPIC_API_KEY not set — skipping signal generation");
    return null;
  }

  try {
    const client = getAnthropicClient();
    const userPrompt = buildSignalsPrompt(stories);

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      temperature: 0.4, // Lower temp for more consistent structured output
      system: SIGNALS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();

    const signals = parseSignals(raw);

    if (signals.length === 0) {
      console.warn("[signals] No signals parsed from Claude output");
      return null;
    }

    const now = new Date();
    const validUntil = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour TTL

    const collection: SignalsCollection = {
      signals,
      generatedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
    };

    console.log(`[signals] Generated ${signals.length} market signals`);
    return collection;
  } catch (error) {
    console.error("[signals] Generation failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}
