/**
 * One-time script: permanently delete all March 12, 2026 articles from KV.
 *
 * Usage:
 *   KV_REST_API_URL="https://..." KV_REST_API_TOKEN="..." node scripts/delete-march12.mjs
 *
 * Find KV_REST_API_URL and KV_REST_API_TOKEN in:
 *   Vercel Dashboard → Your Project → Storage → KV Database → .env.local tab
 */

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  console.error("Set KV_REST_API_URL and KV_REST_API_TOKEN env vars first.");
  console.error("Get them from: Vercel Dashboard → Project → Storage → KV → .env.local tab");
  process.exit(1);
}

// March 13, 2026 00:00:00 UTC in milliseconds
const MARCH_13_CUTOFF_MS = 1773360000000;

async function kvGet(key) {
  const res = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`KV GET failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.result ? JSON.parse(json.result) : null;
}

async function kvSet(key, value) {
  const res = await fetch(`${url}/set/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

(async () => {
  console.log("Connecting to KV...");
  const newsData = await kvGet("news");

  if (!newsData || !Array.isArray(newsData.news)) {
    console.log("No news data found in KV.");
    return;
  }

  const before = newsData.news.length;
  const march12Articles = newsData.news.filter(
    (item) => new Date(item.publishedAt).getTime() < MARCH_13_CUTOFF_MS
  );
  const kept = newsData.news.filter(
    (item) => new Date(item.publishedAt).getTime() >= MARCH_13_CUTOFF_MS
  );

  console.log(`\nFound ${before} total articles`);
  console.log(`March 12 articles to delete: ${march12Articles.length}`);
  march12Articles.forEach((a) =>
    console.log(`  - [${a.id}] ${a.title} (${a.publishedAt})`)
  );

  if (march12Articles.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  console.log(`\nKeeping ${kept.length} articles (March 13+)`);
  console.log("Writing updated news collection to KV...");

  const updated = {
    ...newsData,
    lastUpdated: new Date().toISOString(),
    news: kept,
    meta: {
      ...newsData.meta,
      totalCount: kept.length,
    },
  };

  await kvSet("news", updated);
  console.log(`\nDone. Deleted ${march12Articles.length} March 12 articles.`);
  console.log(`KV now contains ${kept.length} articles.`);
})().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
