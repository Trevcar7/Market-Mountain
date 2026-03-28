import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { getResendClient, AUDIENCE_ID } from "@/lib/email";

export const runtime = "nodejs";

/**
 * GET /api/unsubscribe?email=<email>
 *
 * One-click unsubscribe handler (CAN-SPAM compliant).
 * Removes the subscriber from both KV and Resend Audience.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email")?.trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "Email parameter required" }, { status: 400 });
  }

  const kv = getRedisClient();

  // Remove from KV
  if (kv) {
    try {
      await kv.del(`subscriber:${email}`);
      console.log(`[unsubscribe] Removed ${email} from KV`);
    } catch (err) {
      console.warn("[unsubscribe] KV removal failed:", err);
    }
  }

  // Remove from Resend Audience
  const resend = getResendClient();
  if (resend && AUDIENCE_ID) {
    try {
      // Resend uses contact ID, but we can update by email
      await resend.contacts.update({
        audienceId: AUDIENCE_ID,
        email,
        unsubscribed: true,
      });
      console.log(`[unsubscribe] Marked ${email} as unsubscribed in Resend`);
    } catch (err) {
      console.warn("[unsubscribe] Resend unsubscribe failed:", err);
    }
  }

  // Redirect to a confirmation page
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://marketmountainfinance.com";
  return NextResponse.redirect(`${siteUrl}/preferences?unsubscribed=true`);
}
