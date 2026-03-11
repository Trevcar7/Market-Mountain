type BarChartVariant =
  | "sprouts-revenue"
  | "sprouts-profitability"
  | "sprouts-liquidity"
  | "sprouts-debtequity";

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
    series: [{ name: "Revenue", color: "#22C55E" }],
    yFormat: (v) => `$${v}B`,
    caption: "Revenue in billions USD. Forecast based on 10–13% annual growth rate.",
  },
  "sprouts-profitability": {
    title: "Profitability Ratios vs. Peers",
    data: [
      { label: "Sprouts", values: [6.54, 4.93] },
      { label: "Kroger", values: [2.6, 1.8] },
      { label: "Albertsons", values: [1.9, 1.2] },
    ],
    series: [
      { name: "Operating Margin", color: "#22C55E" },
      { name: "Net Profit Margin", color: "#3B82F6" },
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
      { name: "Current Ratio", color: "#22C55E" },
      { name: "Quick Ratio", color: "#3B82F6" },
      { name: "Cash Ratio", color: "#F59E0B" },
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
    series: [{ name: "D/E Ratio", color: "#22C55E" }],
    yFormat: (v) => v.toFixed(2),
  },
};

const CHART_HEIGHT = 200;
const BAR_AREA = 176; // chart height minus ~24px for value labels

export default function BarChart({ variant }: { variant: BarChartVariant }) {
  const cfg = CHARTS[variant];
  const maxVal = Math.max(...cfg.data.flatMap((g) => g.values));
  const hasLegend = cfg.series.length > 1;

  return (
    <div className="not-prose my-8 rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-slate-50 border-b border-slate-200">
        <p className="text-sm font-semibold text-slate-800">{cfg.title}</p>
      </div>

      {/* Chart */}
      <div className="bg-white px-6 pt-5 pb-3">
        <div
          className="relative flex items-end gap-2 sm:gap-4"
          style={{ height: `${CHART_HEIGHT}px` }}
        >
          {/* Subtle grid lines */}
          {[0.25, 0.5, 0.75, 1.0].map((f) => (
            <div
              key={f}
              className="absolute left-0 right-0 border-t border-slate-100"
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
              <span className="text-xs font-medium text-slate-500 text-center whitespace-nowrap">
                {group.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      {hasLegend && (
        <div className="px-5 py-3 bg-white border-t border-slate-100 flex flex-wrap gap-x-5 gap-y-1.5 justify-center">
          {cfg.series.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-xs text-slate-500">{s.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Caption */}
      {cfg.caption && (
        <div className="bg-slate-50 border-t border-slate-200 px-5 py-2.5 text-[11px] text-slate-400">
          {cfg.caption}
        </div>
      )}
    </div>
  );
}
