import { Redis } from "@upstash/redis";

/**
 * Create an Upstash Redis client from environment variables.
 * Returns null when KV credentials are not configured.
 */
export function getRedisClient(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}
