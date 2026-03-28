import { Resend } from "resend";

/**
 * Create a Resend client from environment variables.
 * Returns null when RESEND_API_KEY is not configured.
 */
export function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

/**
 * The sender address for all Market Mountain emails.
 * Set RESEND_FROM_EMAIL env var to override (e.g., for domain verification).
 * Default: Resend onboarding address (works without domain verification for testing).
 */
export const EMAIL_FROM =
  process.env.RESEND_FROM_EMAIL ?? "Market Mountain <onboarding@resend.dev>";

/** Resend Audience ID for subscriber management. */
export const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID ?? "";
