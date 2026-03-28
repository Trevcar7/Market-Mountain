/** March 13, 2026 00:00:00 UTC — articles before this date are excluded. */
export const MARCH_13_CUTOFF_MS = 1773360000000;

/** Canonical site URL — used across server components, API routes, emails, and metadata. */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://marketmountainfinance.com";
