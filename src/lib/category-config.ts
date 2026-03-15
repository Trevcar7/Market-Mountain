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

/** Light-mode badge colors for briefing and list views. */
export const categoryColors: Record<string, string> = {
  macro: "bg-blue-100 text-blue-800",
  earnings: "bg-purple-100 text-purple-800",
  markets: "bg-amber-100 text-amber-800",
  policy: "bg-teal-100 text-teal-800",
  crypto: "bg-orange-100 text-orange-800",
  other: "bg-slate-100 text-slate-700",
};
