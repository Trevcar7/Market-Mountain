/**
 * Shared news category configuration.
 * Single source of truth for labels, gradients, and badge colors across all news UI.
 */

/** Full labels for article pages and cards. */
export const categoryLabels: Record<string, string> = {
  macro: "Macro Economics",
  earnings: "Earnings",
  markets: "Markets",
  policy: "Policy & Economics",
  crypto: "Crypto",
  other: "Market News",
};

/** Short labels for briefing badges and compact UI. */
export const categoryLabelsShort: Record<string, string> = {
  macro: "Macro",
  earnings: "Earnings",
  markets: "Markets",
  policy: "Policy",
  crypto: "Crypto",
  other: "News",
};

/** Dark-mode gradient backgrounds for hero cards and cover images. */
export const categoryGradients: Record<string, string> = {
  macro: "from-blue-900 via-blue-950 to-navy-900",
  earnings: "from-purple-900 via-purple-950 to-navy-900",
  markets: "from-amber-900 via-amber-950 to-navy-900",
  policy: "from-teal-900 via-teal-950 to-navy-900",
  crypto: "from-orange-900 via-orange-950 to-navy-900",
  other: "from-slate-800 via-slate-900 to-navy-900",
};

/** Badge colors for briefing and list views (light + dark). */
export const categoryColors: Record<string, string> = {
  macro: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  earnings: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  markets: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  policy: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  crypto: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  other: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

/** Category-specific accent for pull quotes and section dividers. */
export const categoryAccentBorder: Record<string, string> = {
  macro: "border-blue-500",
  earnings: "border-purple-500",
  markets: "border-amber-500",
  policy: "border-teal-500",
  crypto: "border-orange-500",
  other: "border-accent-500",
};

export const categoryAccentText: Record<string, string> = {
  macro: "text-blue-600 dark:text-blue-400",
  earnings: "text-purple-600 dark:text-purple-400",
  markets: "text-amber-600 dark:text-amber-400",
  policy: "text-teal-600 dark:text-teal-400",
  crypto: "text-orange-600 dark:text-orange-400",
  other: "text-accent-600 dark:text-accent-400",
};
