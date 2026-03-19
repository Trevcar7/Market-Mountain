import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { NewsCollection } from "@/lib/news-types";
import { getAnthropicClient, CLAUDE_MODEL } from "@/lib/anthropic-client";

export const maxDuration = 120;
export const runtime = "nodejs";

/**
 * POST /api/admin/rewrite-headings
 *
 * Uses Claude to rewrite generic section headings ("Event Summary",
 * "Market Reaction", etc.) into article-specific, engaging headings.
 * Also fetches an inline image for each article.
 *
 * Only processes articles that still have generic headings.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kv = getRedisClient();
  if (!kv) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return NextResponse.json({ error: "Anthropic client not configured" }, { status: 500 });
  }

  try {
    const collection = await kv.get<NewsCollection>("news");
    if (!collection?.news?.length) {
      return NextResponse.json({ message: "No articles", rewritten: 0 });
    }

    const GENERIC_HEADINGS = new Set([
      "Event Summary", "Market Reaction", "Macro Context", "Macro Analysis",
      "Investor Implications", "What to Watch", "What to Watch Next",
      "Market Reaction and Dealmaker Sentiment",
      "Macro Context and Deal Pipeline Growth",
      "Investor Implications for Pharma and Biotech",
    ]);

    const results: Array<{ title: string; headings: string[] }> = [];

    for (const article of collection.news) {
      // Check if article has generic headings
      const headingMatches = article.story.match(/^## (.+)$/gm) ?? [];
      const headings = headingMatches.map((h) => h.slice(3));
      const genericCount = headings.filter((h) => GENERIC_HEADINGS.has(h)).length;

      // Fetch inline image BEFORE the heading check so articles with
      // already-custom headings still get images
      if (!article.inlineImageUrl) {
        try {
          const apiKey = process.env.UNSPLASH_ACCESS_KEY;
          if (apiKey) {
            const titleWords = article.title
              .replace(/[^a-zA-Z\s]/g, " ")
              .split(/\s+/)
              .filter((w) => w.length > 4)
              .slice(0, 3)
              .join(" ");
            const query = titleWords || article.title.slice(0, 30);
            const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape&content_filter=high`;
            const res = await fetch(url, {
              headers: { Authorization: `Client-ID ${apiKey}` },
            });
            if (res.ok) {
              const data = await res.json();
              const photos = data?.results ?? [];
              const heroBase = article.imageUrl?.split("?")[0] ?? "";
              const suitable = photos.find(
                (p: { urls?: { regular?: string } }) => {
                  const photoUrl = p.urls?.regular;
                  return photoUrl && !photoUrl.startsWith(heroBase);
                }
              );
              if (suitable?.urls?.regular) {
                const base = suitable.urls.regular.split("?")[0];
                article.inlineImageUrl = `${base}?w=1200&q=80`;
                article.inlineImageCaption = article.title.split(/[:\—,]/)[0].trim();
                article.inlineImagePosition = 5;
                results.push({ title: article.title, headings: ["+ inline image added"] });
              }
            }
          }
        } catch { /* non-blocking */ }
      }

      if (genericCount < 3) continue; // Already has custom headings

      // Build the prompt for Claude
      const sections = article.story.split(/(?=^## )/m).filter((s) => s.trim());
      const sectionSummaries = sections.map((s) => {
        const lines = s.trim().split("\n");
        const heading = lines[0]?.replace("## ", "") ?? "";
        const body = lines.slice(1).join(" ").trim().slice(0, 200);
        return `CURRENT: "## ${heading}"\nCONTENT: ${body}`;
      }).join("\n\n");

      try {
        const response = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 300,
          messages: [{
            role: "user",
            content: `Rewrite the section headings for this financial news article. Each heading must be specific to the article content — no generic labels.

ARTICLE TITLE: "${article.title}"

SECTIONS:
${sectionSummaries}

Rules:
- Each heading must reference a specific company, number, event, or consequence from that section
- 4-8 words per heading
- No colons or dashes
- Prefix each with "## "
- Return ONLY the 5 new headings, one per line, in order

Examples of GOOD headings:
## Lululemon Beats Q4 but Slashes 2026 Outlook
## Athletic Retail Stocks Slide on Tariff Exposure
## Patent Cliffs and Tariff Costs Collide
## Short Duration Bonds Over Discretionary
## March FOMC and April CPI Are Next`,
          }],
        });

        const text = response.content[0].type === "text" ? response.content[0].text : "";
        const newHeadings = text.split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("## "))
          .map((l) => l.slice(3));

        if (newHeadings.length >= 5) {
          // Replace headings in the story
          let updatedStory = article.story;
          for (let i = 0; i < Math.min(headings.length, newHeadings.length); i++) {
            if (GENERIC_HEADINGS.has(headings[i])) {
              updatedStory = updatedStory.replace(`## ${headings[i]}`, `## ${newHeadings[i]}`);
            }
          }
          article.story = updatedStory;
          results.push({ title: article.title, headings: newHeadings });
        }
      } catch (err) {
        console.error(`[rewrite-headings] Claude failed for "${article.title}":`, err);
      }

    }

    // Save
    if (results.length > 0) {
      collection.lastUpdated = new Date().toISOString();
      await kv.set("news", collection);
    }

    return NextResponse.json({
      message: `Processed ${results.length} articles`,
      results,
    });
  } catch (error) {
    console.error("[rewrite-headings] Error:", error);
    return NextResponse.json(
      { error: "Failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
