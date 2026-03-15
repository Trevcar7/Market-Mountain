import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;

/**
 * Singleton Anthropic client. Throws if ANTHROPIC_API_KEY is missing.
 */
export function getAnthropicClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is required");
    client = new Anthropic({ apiKey });
  }
  return client;
}
