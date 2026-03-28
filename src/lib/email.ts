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

/** The sender address for all Market Mountain emails. */
export const EMAIL_FROM = "Market Mountain <briefing@marketmountainfinance.com>";

/** Resend Audience ID for subscriber management. */
export const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID ?? "";
