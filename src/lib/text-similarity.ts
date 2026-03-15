/**
 * Shared text-similarity utilities.
 * Used by NewsSection (display dedup) and co-publication-validator (publish-time dedup).
 */

export const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","as",
  "is","are","was","were","be","been","being","it","its","by","from","that",
  "this","these","those","will","would","could","should","may","might","has",
  "have","had","not","no","new","all","more","after","than","into","up","out",
  "s","do","did","over","said","say","says","their","they","we","us",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}
