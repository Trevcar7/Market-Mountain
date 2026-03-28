/**
 * One-time migration: copies existing subscribers from Vercel KV to Resend Audience.
 *
 * Usage:
 *   npx tsx scripts/migrate-subscribers.ts
 *
 * Required env vars:
 *   KV_REST_API_URL, KV_REST_API_TOKEN — Vercel KV credentials
 *   RESEND_API_KEY — Resend API key
 *   RESEND_AUDIENCE_ID — Resend Audience ID (create one at resend.com/audiences)
 */

import { Redis } from "@upstash/redis";
import { Resend } from "resend";

async function migrate() {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const resendKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!kvUrl || !kvToken) {
    console.error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");
    process.exit(1);
  }
  if (!resendKey) {
    console.error("Missing RESEND_API_KEY");
    process.exit(1);
  }
  if (!audienceId) {
    console.error("Missing RESEND_AUDIENCE_ID — create one at resend.com/audiences");
    process.exit(1);
  }

  const kv = new Redis({ url: kvUrl, token: kvToken });
  const resend = new Resend(resendKey);

  // Read all subscribers from KV
  const raw = await kv.lrange("subscribers-list", 0, -1);
  console.log(`Found ${raw.length} subscribers in KV`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of raw) {
    try {
      const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
      const email = (parsed as { email?: string })?.email;
      if (!email) {
        skipped++;
        continue;
      }

      const { error } = await resend.contacts.create({
        audienceId,
        email,
        unsubscribed: false,
      });

      if (error) {
        // "Contact already exists" is fine — skip silently
        if (String(error).includes("already exists")) {
          skipped++;
        } else {
          console.error(`  Failed: ${email} — ${JSON.stringify(error)}`);
          failed++;
        }
      } else {
        console.log(`  Migrated: ${email}`);
        migrated++;
      }

      // Rate limit: Resend allows ~10 req/sec
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      console.error(`  Error processing entry:`, err);
      failed++;
    }
  }

  console.log(`\nDone: ${migrated} migrated, ${skipped} skipped, ${failed} failed`);
}

migrate().catch(console.error);
