import { NextResponse } from "next/server";
import { buildMacroBoardIndicators } from "@/lib/macro-board-builder";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET /api/briefing-macro
 * Returns the same indicators as /api/macro-board, mapped to KeyDataPoint[].
 * This ensures the Macro Snapshot on the briefing page always agrees with
 * the MacroBoard on the homepage — they share the same underlying builder.
 */
export async function GET() {
  const indicators = await buildMacroBoardIndicators();
  // MacroIndicator fields are a superset of KeyDataPoint — map directly
  const keyData = indicators.map(({ label, value, change, source }) => ({
    label,
    value,
    ...(change ? { change } : {}),
    ...(source ? { source } : {}),
  }));
  return NextResponse.json(keyData, {
    headers: { "Cache-Control": "no-store" },
  });
}
