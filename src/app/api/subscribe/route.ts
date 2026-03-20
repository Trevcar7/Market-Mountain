import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KV_LIST_KEY = "subscribers-list";

/**
 * POST /api/subscribe
 * Stores an email subscriber in Vercel KV.
 *
 * Body: { email: string }
 * Response: { success: true } or { error: string }
 *
 * Idempotent — re-subscribing the same email is a silent success.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const kv = getRedisClient();

    if (!kv) {
      // KV not configured — log and return success so the UI still works
      console.warn("[/api/subscribe] KV not configured — email not stored:", email);
      return NextResponse.json({ success: true });
    }

    const subscriberKey = `subscriber:${email}`;
    const now = new Date().toISOString();

    // Check if already subscribed (idempotent)
    const existing = await kv.get(subscriberKey);
    if (existing) {
      return NextResponse.json({ success: true });
    }

    // Store individual subscriber record
    await kv.set(subscriberKey, { email, subscribedAt: now });

    // Append to subscriber list for easy retrieval/export
    await kv.lpush(KV_LIST_KEY, JSON.stringify({ email, subscribedAt: now }));

    console.log(`[/api/subscribe] New subscriber: ${email}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[/api/subscribe] Error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
