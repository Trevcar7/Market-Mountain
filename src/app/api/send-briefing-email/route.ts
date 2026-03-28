import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { getResendClient, EMAIL_FROM, AUDIENCE_ID } from "@/lib/email";
import BriefingEmail from "@/emails/BriefingEmail";
import type { DailyBriefing } from "@/lib/news-types";

export const maxDuration = 30;
export const runtime = "nodejs";

/**
 * GET /api/send-briefing-email
 *
 * Triggered by Vercel Cron at 12:15 UTC (8:15 AM ET) on weekdays.
 * Fetches today's briefing from KV, then sends it to all Resend Audience contacts.
 *
 * Idempotent: uses `email-sent-<date>` flag in KV to prevent double-sends.
 * Auth: requires Vercel CRON_SECRET Bearer token.
 */
export async function GET(request: NextRequest) {
  // Auth: accept Vercel Cron authorization
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronTrigger = cronSecret && authHeader === `Bearer ${cronSecret}`;

  // Also accept FETCH_NEWS_SECRET for manual triggers
  const fetchSecret = process.env.FETCH_NEWS_SECRET;
  const token = request.headers.get("x-fetch-news-token");
  const isManualTrigger = fetchSecret && token === fetchSecret;

  if (process.env.NODE_ENV === "production" && !isCronTrigger && !isManualTrigger) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resend = getResendClient();
  if (!resend) {
    console.warn("[send-briefing-email] RESEND_API_KEY not configured — skipping");
    return NextResponse.json({ success: false, reason: "Resend not configured" });
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ success: false, reason: "KV not configured" }, { status: 503 });
  }

  const today = new Date().toISOString().split("T")[0];
  const sentKey = `email-sent-${today}`;

  // Idempotency check — prevent double-sends
  try {
    const alreadySent = await kv.get(sentKey);
    if (alreadySent) {
      console.log(`[send-briefing-email] Already sent for ${today} — skipping`);
      return NextResponse.json({ success: true, skipped: true, reason: "Already sent today" });
    }
  } catch {
    // Non-fatal — proceed with send
  }

  // Fetch today's briefing
  const briefingKey = `briefing-${today}`;
  let briefing: DailyBriefing | null = null;
  try {
    briefing = await kv.get<DailyBriefing>(briefingKey);
  } catch (err) {
    console.error("[send-briefing-email] Failed to load briefing:", err);
    return NextResponse.json({ success: false, reason: "Failed to load briefing" }, { status: 500 });
  }

  if (!briefing) {
    console.warn(`[send-briefing-email] No briefing found for ${today}`);
    return NextResponse.json({ success: false, reason: "No briefing for today" });
  }

  // Format the date for the subject line
  const dateDisplay = new Date(today + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  try {
    // Send to Resend Audience (batch send)
    if (AUDIENCE_ID) {
      const { data, error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: AUDIENCE_ID, // Resend Audience ID sends to all contacts
        subject: `${briefing.leadStory.title} — Market Mountain Briefing, ${dateDisplay}`,
        react: BriefingEmail({ briefing }),
      });

      if (error) {
        console.error("[send-briefing-email] Resend error:", error);
        return NextResponse.json({ success: false, reason: String(error) }, { status: 500 });
      }

      console.log(`[send-briefing-email] Sent briefing for ${today}`, data);
    } else {
      // No audience configured — send to subscribers from KV as fallback
      const subscriberList = await kv.lrange("subscribers-list", 0, -1);
      const emails = subscriberList
        .map((entry) => {
          try {
            const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
            return parsed?.email;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as string[];

      if (emails.length === 0) {
        console.warn("[send-briefing-email] No subscribers found");
        return NextResponse.json({ success: false, reason: "No subscribers" });
      }

      // Send in batches of 50 (Resend rate limit)
      const batchSize = 50;
      let sentCount = 0;

      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);
        const { error } = await resend.batch.send(
          batch.map((email) => ({
            from: EMAIL_FROM,
            to: email,
            subject: `${briefing!.leadStory.title} — Market Mountain Briefing, ${dateDisplay}`,
            react: BriefingEmail({ briefing: briefing! }),
          }))
        );

        if (error) {
          console.error(`[send-briefing-email] Batch ${i / batchSize + 1} error:`, error);
        } else {
          sentCount += batch.length;
        }
      }

      console.log(`[send-briefing-email] Sent briefing to ${sentCount}/${emails.length} subscribers`);
    }

    // Mark as sent (24h TTL — auto-cleans up)
    await kv.set(sentKey, { sentAt: new Date().toISOString(), date: today }, { ex: 24 * 60 * 60 });

    return NextResponse.json({ success: true, date: today });
  } catch (err) {
    console.error("[send-briefing-email] Send failed:", err);
    return NextResponse.json({ success: false, reason: String(err) }, { status: 500 });
  }
}
