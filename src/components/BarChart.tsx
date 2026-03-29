type BarChartVariant =
  | "sprouts-revenue"
  | "sprouts-profitability"
  | "sprouts-liquidity"
  | "sprouts-debtequity"
  | "siri-revenue-ebitda"
  | "siri-fcf"
  | "siri-debt-coverage"
  | "fslr-revenue"
  | "fslr-tax-credits";

interface SeriesConfig {
  name: string;
  color: string;
}

interface GroupData {
  label: string;
  values: number[];
}

interface ChartConfig {
  title: string;
  data: GroupData[];
  series: SeriesConfig[];
  yFormat: (v: number) => string;
  caption?: string;
}

const CHARTS: Record<BarChartVariant, ChartConfig> = {
  "sprouts-revenue": {
    title: "Sprouts Forecasted Revenue Growth",
    data: [
      { label: "2025", values: [8.7] },
      { label: "2026", values: [9.5] },
      { label: "2027", values: [10.4] },
      { label: "2028", values: [11.3] },
      { label: "2029", values: [12.3] },
    ],
    series: [{ name: "Revenue", color: "#2a783a" }],
    yFormat: (v) => `$${v}B`,
    caption: "Revenue in billions USD. Forecast based on 10 to 13% annual growth rate.",
  },
  "sprouts-profitability": {
    title: "Profitability Ratios vs. Peers",
    data: [
      { label: "Sprouts", values: [6.54, 4.93] },
      { label: "Kroger", values: [2.6, 1.8] },
      { label: "Albertsons", values: [1.9, 1.2] },
    ],
    series: [
      { name: "Operating Margin", color: "#2a783a" },
      { name: "Net Profit Margin", color: "#6bbd45" },
    ],
    yFormat: (v) => `${v}%`,
  },
  "sprouts-liquidity": {
    title: "Liquidity Ratios vs. Peers",
    data: [
      { label: "Sprouts", values: [0.99, 0.49, 0.39] },
      { label: "Kroger", values: [0.95, 0.36, 0.25] },
      { label: "Albertsons", values: [0.9, 0.22, 0.03] },
    ],
    series: [
      { name: "Current Ratio", color: "#2a783a" },
      { name: "Quick Ratio", color: "#6bbd45" },
      { name: "Cash Ratio", color: "#94A3B8" },
    ],
    yFormat: (v) => v.toFixed(2),
  },
  "sprouts-debtequity": {
    title: "Debt-to-Equity Ratio vs. Peers",
    data: [
      { label: "Sprouts", values: [1.27] },
      { label: "Kroger", values: [3.03] },
      { label: "Albertsons", values: [4.17] },
    ],
    series: [{ name: "D/E Ratio", color: "#2a783a" }],
    yFormat: (v) => v.toFixed(2),
  },
  "siri-revenue-ebitda": {
    title: "SiriusXM Revenue & Adjusted EBITDA ($B)",
    data: [
      { label: "FY2023", values: [8.96, 2.79] },
      { label: "FY2024", values: [8.70, 2.73] },
      { label: "FY2025", values: [8.56, 2.67] },
    ],
    series: [
      { name: "Revenue", color: "#0000EB" },
      { name: "Adj. EBITDA", color: "#94A3B8" },
    ],
    yFormat: (v) => `$${v.toFixed(1)}B`,
    caption: "Revenue declining 0.6% to 2.9% annually while EBITDA margins remain stable at 31%. Source: SiriusXM 10-K filings.",
  },
  "siri-fcf": {
    title: "SiriusXM Free Cash Flow ($B)",
    data: [
      { label: "FY2023", values: [1.18] },
      { label: "FY2024", values: [1.02] },
      { label: "FY2025", values: [1.26] },
    ],
    series: [{ name: "Free Cash Flow", color: "#0000EB" }],
    yFormat: (v) => `$${v.toFixed(2)}B`,
    caption: "FCF rebounded to $1.26B in FY2025, representing a 15% FCF margin. Source: SiriusXM 10-K filings.",
  },
  "siri-debt-coverage": {
    title: "SiriusXM Debt & EBITDA Coverage",
    data: [
      { label: "Total Debt", values: [9.60] },
      { label: "Adj. EBITDA", values: [2.67] },
      { label: "Annual FCF", values: [1.26] },
    ],
    series: [{ name: "Amount ($B)", color: "#0000EB" }],
    yFormat: (v) => `$${v.toFixed(2)}B`,
    caption: "Net Debt/EBITDA of 3.6x. At current FCF, debt could be fully retired in 7.6 years. Source: SiriusXM 10-K filings.",
  },
  "fslr-revenue": {
    title: "First Solar Revenue Growth ($B)",
    data: [
      { label: "FY2023", values: [3.3] },
      { label: "FY2024", values: [4.2] },
      { label: "FY2025E", values: [5.5] },
    ],
    series: [{ name: "Revenue", color: "#EE2821" }],
    yFormat: (v) => `$${v.toFixed(1)}B`,
    caption: "FY2025E based on midpoint of $5.3-5.8B management guidance. Source: First Solar 10-K filings.",
  },
  "fslr-tax-credits": {
    title: "First Solar 45X Tax Credit Revenue ($B)",
    data: [
      { label: "FY2023", values: [0.66] },
      { label: "FY2024", values: [0.82] },
      { label: "FY2025E", values: [1.68] },
    ],
    series: [{ name: "Tax Credits", color: "#EE2821" }],
    yFormat: (v) => `$${v.toFixed(2)}B`,
    caption: "IRA 45X manufacturing tax credits sold at ~$0.95 on the dollar. FY2025E based on midpoint of $1.65-1.7B guidance.",
  },
};

const CHART_HEIGHT = 200;
const BAR_AREA = 176; // chart height minus ~24px for value labels

export default function BarChart({ variant }: { variant: BarChartVariant }) {
  const cfg = CHARTS[variant];
  const maxVal = Math.max(...cfg.data.flatMap((g) => g.values));
  const hasLegend = cfg.series.length > 1;

  return (
    <div className="not-prose my-8 rounded-xl border border-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-surface-2 border-b border-border">
        <p className="text-sm font-semibold text-text">{cfg.title}</p>
      </div>

      {/* Chart */}
      <div className="bg-card px-6 pt-5 pb-3">
        <div
          className="relative flex items-end gap-2 sm:gap-4"
          style={{ height: `${CHART_HEIGHT}px` }}
        >
          {/* Subtle grid lines */}
          {[0.25, 0.5, 0.75, 1.0].map((f) => (
            <div
              key={f}
              className="absolute left-0 right-0 border-t border-border/60"
              style={{ bottom: `${f * BAR_AREA}px` }}
            />
          ))}

          {/* Bar groups */}
          {cfg.data.map((group) => (
            <div
              key={group.label}
              className="relative z-10 flex flex-col items-center flex-1 gap-1"
            >
              {/* Bars + value labels */}
              <div
                className="flex items-end gap-0.5 w-full"
                style={{ height: `${CHART_HEIGHT - 20}px` }}
              >
                {group.values.map((val, si) => {
                  const barH = Math.max(3, (val / maxVal) * BAR_AREA);
                  return (
                    <div
                      key={si}
                      className="flex flex-col items-center flex-1"
                      style={{ height: `${CHART_HEIGHT - 20}px`, justifyContent: "flex-end" }}
                    >
                      <span
                        className="text-[10px] font-semibold leading-none mb-1"
                        style={{ color: cfg.series[si].color }}
                      >
                        {cfg.yFormat(val)}
                      </span>
                      <div
                        style={{
                          height: `${barH}px`,
                          width: "100%",
                          maxWidth: "56px",
                          backgroundColor: cfg.series[si].color,
                          borderRadius: "3px 3px 0 0",
                          opacity: si > 0 ? 0.8 : 1,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              {/* Category label */}
              <span className="text-xs font-medium text-text-muted text-center whitespace-nowrap">
                {group.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      {hasLegend && (
        <div className="px-5 py-3 bg-card border-t border-border flex flex-wrap gap-x-5 gap-y-1.5 justify-center">
          {cfg.series.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-xs text-text-muted">{s.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Caption */}
      {cfg.caption && (
        <div className="bg-surface-2 border-t border-border px-5 py-2.5 text-[11px] text-text-light">
          {cfg.caption}
        </div>
      )}
    </div>
  );
}
