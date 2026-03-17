import { NextResponse } from "next/server";
import { fetchBriefingMacroPanel } from "@/lib/market-data";

export const runtime = "nodejs";
export const maxDuration = 15;

// No-cache — always returns fresh data for client-side polling
export async function GET() {
  const data = await fetchBriefingMacroPanel();
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}
