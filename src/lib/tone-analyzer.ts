import fs from "fs";
import path from "path";

export interface ToneProfile {
  vocabulary: {
    commonThemes: string[];
    formalityLevel: string;
    jargonDensity: string;
  };
  sentenceStructure: {
    averageLength: number;
    shortPunchy: string[];
    longAnalytical: string[];
  };
  perspective: {
    voiceType: string;
    personalReferences: boolean;
    authorityLevel: string;
  };
  toneMarkers: {
    skepticism: boolean;
    confidence: boolean;
    caution: boolean;
    enthusiasm: boolean;
  };
  commonPhrases: string[];
  styleExamples: string[];
  instructions: string;
}

/**
 * Analyzes existing articles to extract Trevor's writing voice & style.
 * Returns a ToneProfile used in Gemini system prompts.
 */
export async function analyzeTone(): Promise<ToneProfile> {
  const postsDir = path.join(process.cwd(), "src/content/posts");
  const files = fs.readdirSync(postsDir).filter((f) => f.endsWith(".md"));

  let fullText = "";
  const styleExamples: string[] = [];

  // Read all articles and extract content
  for (const file of files) {
    const filePath = path.join(postsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    // Extract body (after frontmatter)
    const bodyMatch = content.split("---").slice(2).join("---");
    fullText += bodyMatch + "\n";

    // Extract 1-2 notable quotes/examples per article
    const sentences = bodyMatch
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 50 && s.length < 300);

    if (sentences.length > 0) {
      styleExamples.push(sentences[Math.floor(Math.random() * sentences.length)]);
    }
  }

  // Extract vocabulary themes
  const commonThemes = [
    "valuation",
    "fundamentals",
    "discipline",
    "patience",
    "opportunity",
    "margin of safety",
    "intrinsic value",
    "DCF analysis",
    "financial health",
    "long-term growth",
  ];

  // Extract common phrases Trevor uses
  const commonPhrases = [
    "Investors willing to...",
    "This highlights that...",
    "By contrast...",
    "Notably...",
    "Rather than...",
    "The result is...",
    "Despite robust...",
    "This appears to be...",
    "When compared to...",
    "In today's market environment...",
    "Understanding the... is crucial",
    "Ultimately...",
    "A patient investor...",
  ];

  // Analyze sentence structure from sample sentences
  const sentences = fullText.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgLength =
    sentences.reduce((sum, s) => sum + s.trim().split(" ").length, 0) /
    sentences.length;

  const shortPunchy = sentences
    .filter((s) => s.trim().split(" ").length <= 10)
    .slice(0, 5);

  const longAnalytical = sentences
    .filter((s) => s.trim().split(" ").length > 20)
    .slice(0, 5);

  const toneProfile: ToneProfile = {
    vocabulary: {
      commonThemes,
      formalityLevel:
        "Professional but accessible—avoids unnecessary jargon while using financial terminology precisely",
      jargonDensity:
        "Moderate—uses financial terms (DCF, WACC, fundamentals, valuation) naturally, explains complex concepts",
    },
    sentenceStructure: {
      averageLength: Math.round(avgLength),
      shortPunchy: shortPunchy.map((s) => s.trim()),
      longAnalytical: longAnalytical.map((s) => s.trim()),
    },
    perspective: {
      voiceType: "First-person investor perspective—uses 'I view', 'I bought', 'my analysis'",
      personalReferences: true,
      authorityLevel:
        "Confident but measured—acknowledges risks and limitations, avoids overstatement",
    },
    toneMarkers: {
      skepticism: true, // Questions overreactions, examines root causes
      confidence: true, // Backs claims with data and analysis
      caution: true, // Warns about traps, risk, losses
      enthusiasm: true, // Excited about good opportunities
    },
    commonPhrases,
    styleExamples: styleExamples.slice(0, 8),
    instructions: `
TONE & VOICE INSTRUCTIONS FOR GEMINI:
You are writing financial news synthesis in the voice of Trevor Carnovsky, a disciplined value investor and financial analyst.

STYLE REQUIREMENTS:
1. Write from a first-person or analytical perspective (can use "investors should" or "I view")
2. Use precise financial terminology naturally—don't over-explain obvious terms
3. Mix short punchy sentences with longer analytical ones for rhythm
4. Base ALL claims strictly on the source articles provided—do not infer, extrapolate, or speculate
5. Include skeptical analysis—question hype, examine root causes, look beyond surface reactions
6. Acknowledge risk and complexity where it exists

VOICE MARKERS:
- Start with a strong analytical hook (not just a headline restate)
- Use comparative language: "By contrast...", "Unlike...", "This highlights..."
- Reference underlying fundamentals, not just price movements
- If discussing sentiment, ground it in data/actions
- End with actionable takeaway or what to watch

EXAMPLES OF GOOD STYLE:
${styleExamples.slice(0, 3).join("\n")}

DO NOT:
- Use corporate/marketing language ("exciting opportunity", "unprecedented growth")
- Make claims not directly supported by source articles
- Use hype language or FOMO framings
- Be overly casual or use slang
- Repeat source headlines verbatim
    `,
  };

  return toneProfile;
}

/**
 * Format tone profile for inclusion in Gemini system prompt
 */
export function formatToneForPrompt(profile: ToneProfile): string {
  return `
WRITE IN THIS VOICE:
- Perspective: ${profile.perspective.voiceType}
- Tone: ${profile.toneMarkers.skepticism ? "Skeptical yet data-driven" : ""}, ${profile.toneMarkers.confidence ? "Confident but measured" : ""}, ${profile.toneMarkers.caution ? "Cautious about risks" : ""}
- Common themes: ${profile.vocabulary.commonThemes.slice(0, 5).join(", ")}
- Use phrases like: "${profile.commonPhrases.slice(0, 3).join('", "')}"
- Sentence rhythm: Mix ${profile.sentenceStructure.averageLength}-word average with short punchy sentences and longer analytical ones
- Formality: ${profile.vocabulary.formalityLevel}

${profile.instructions}
  `;
}
