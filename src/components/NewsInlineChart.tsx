import { ChartDataset, KeyDataPoint } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// NewsInlineChart
// Renders a ChartDataset inline within an article body.
// Pure SVG — no external charting library required.
//
// Design improvements (visual editorial QA, March 2026):
//   • Line charts use a tight y-axis anchored to the data range (not 0)
//     so movements are clearly visible at macro scale.
//   • Bar charts keep a zero baseline (handles negative values like GDP growth).
//   • Optional reference line (chart.referenceValue) — e.g., Fed 2% inflation target.
//   • Last data point is labelled in accent color for quick reading.
//   • YYYY-MM-DD date labels are formatted as "Mar '25" for readability.
// ---------------------------------------------------------------------------

interface NewsInlineChartProps {
  chart: ChartDataset;
}

/** Format YYYY-MM-DD or "Mon YYYY" labels into short "Mar '25" form */
function formatXLabel(label: string): string {
  // YYYY-MM-DD (FRED daily/monthly)
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const [year, month] = label.split("-");
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${MONTHS[parseInt(month, 10) - 1]} '${year.slice(2)}`;
  }
  // "March 2025" → "Mar '25"
  const longMonthMatch = label.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (longMonthMatch) {
    return `${longMonthMatch[1].slice(0, 3)} '${longMonthMatch[2].slice(2)}`;
  }
  return label;
}

export function NewsInlineChart({ chart }: NewsInlineChartProps) {
  const W = 600;
  const H = 220;
  const PADDING = { top: 28, right: 20, bottom: 44, left: 52 };
  const plotW = W - PADDING.left - PADDING.right;
  const plotH = H - PADDING.top - PADDING.bottom;

  const dataMin = Math.min(...chart.values);
  const dataMax = Math.max(...chart.values);
  const dataRange = dataMax - dataMin || 1;

  // ── Y-axis bounds ──────────────────────────────────────────────────────────
  // Line charts: tight range around the data (macro rates rarely start at 0).
  // Bar charts: zero-based so bar heights are proportionally honest.
  let axisMin: number;
  let axisMax: number;

  if (chart.type === "bar") {
    axisMin = Math.min(0, dataMin);
    axisMax = Math.max(0, dataMax) + dataRange * 0.15;
  } else {
    const pad = dataRange * 0.22;
    axisMin = Math.max(0, dataMin - pad);
    axisMax = dataMax + pad;

    // Ensure referenceValue is within view with a small margin
    if (chart.referenceValue !== undefined) {
      const refPad = dataRange * 0.10;
      axisMin = Math.min(axisMin, chart.referenceValue - refPad);
      axisMax = Math.max(axisMax, chart.referenceValue + refPad);
    }
  }

  const axisRange = axisMax - axisMin || 1;

  const xStep = plotW / Math.max(chart.labels.length - 1, 1);
  const toY = (v: number) => plotH - ((v - axisMin) / axisRange) * plotH;

  const formatValue = (v: number) => {
    const unit = chart.unit ?? "";
    if (unit === "%") return `${v.toFixed(1)}%`;
    if (unit === "Points") return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);
    if (unit === "$/bbl") return `$${v.toFixed(0)}`;
    if (unit === "$B") return `$${v.toFixed(1)}B`;
    if (unit === "$") return `$${v.toLocaleString()}`;
    return `${v.toFixed(2)}`;
  };

  const ACCENT = "#22C55E";
  const GRID = "#e2e8f0";
  const AXIS = "#94a3b8";
  const TEXT = "#64748b";
  const REF_COLOR = "#94a3b8";

  // Show first, last, and evenly-spaced labels — at most 6 x-axis ticks
  const labelStep = chart.labels.length > 8 ? Math.ceil(chart.labels.length / 6) : 1;
  const showLabel = (i: number) =>
    i === 0 || i === chart.labels.length - 1 || i % labelStep === 0;

  // ── LINE CHART ─────────────────────────────────────────────────────────────
  if (chart.type === "line") {
    const points = chart.values.map((v, i) => ({
      x: PADDING.left + i * xStep,
      y: PADDING.top + toY(v),
    }));
    const pathD = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");

    const lastPt = points[points.length - 1];
    const lastVal = chart.values[chart.values.length - 1];

    // Reference line y-position (if set and within plot bounds)
    const refY =
      chart.referenceValue !== undefined
        ? PADDING.top + toY(chart.referenceValue)
        : null;
    const refInBounds =
      refY !== null && refY >= PADDING.top && refY <= PADDING.top + plotH;

    return (
      <figure className="not-prose my-8 rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="bg-slate-50 border-b border-slate-200 px-5 py-3">
          <p className="text-sm font-semibold text-slate-800">{chart.title}</p>
          {chart.timeRange && (
            <p className="text-xs text-slate-500 mt-0.5">{chart.timeRange}</p>
          )}
        </div>
        <div className="bg-white px-4 py-4 overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ maxHeight: 240 }}
            aria-label={chart.title}
          >
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const y = PADDING.top + f * plotH;
              const v = axisMax - f * axisRange;
              return (
                <g key={f}>
                  <line
                    x1={PADDING.left} y1={y}
                    x2={W - PADDING.right} y2={y}
                    stroke={GRID} strokeWidth="1"
                  />
                  <text x={PADDING.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill={AXIS}>
                    {formatValue(v)}
                  </text>
                </g>
              );
            })}

            {/* Reference line (e.g., Fed 2% inflation target) */}
            {refInBounds && refY !== null && (
              <g>
                <line
                  x1={PADDING.left} y1={refY}
                  x2={W - PADDING.right} y2={refY}
                  stroke={REF_COLOR} strokeWidth="1.5" strokeDasharray="5 4"
                />
                {chart.referenceLabel && (
                  <text
                    x={PADDING.left + 6} y={refY - 5}
                    fontSize="9" fill={REF_COLOR}
                  >
                    {chart.referenceLabel}
                  </text>
                )}
              </g>
            )}

            {/* X axis labels */}
            {chart.labels.map((label, i) => {
              if (!showLabel(i)) return null;
              const x = PADDING.left + i * xStep;
              return (
                <text key={i} x={x} y={H - 10} textAnchor="middle" fontSize="10" fill={TEXT}>
                  {formatXLabel(label)}
                </text>
              );
            })}

            {/* Line */}
            <path
              d={pathD} fill="none"
              stroke={ACCENT} strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
            />

            {/* Data points — smaller dots, last point highlighted */}
            {points.map((p, i) => (
              <circle
                key={i} cx={p.x} cy={p.y}
                r={i === points.length - 1 ? 4.5 : 2.5}
                fill={ACCENT}
                stroke={i === points.length - 1 ? "white" : "none"}
                strokeWidth="1.5"
              />
            ))}

            {/* Latest value callout */}
            <text
              x={lastPt.x} y={lastPt.y - 12}
              textAnchor={lastPt.x > W * 0.8 ? "end" : "middle"}
              fontSize="11" fontWeight="700" fill={ACCENT}
            >
              {formatValue(lastVal)}
            </text>
          </svg>
        </div>
        {chart.source && (
          <div className="bg-slate-50 border-t border-slate-200 px-5 py-2 text-[10px] text-slate-400">
            Source: {chart.source}
          </div>
        )}
      </figure>
    );
  }

  // ── BAR CHART ──────────────────────────────────────────────────────────────
  const barW = Math.max(4, (plotW / chart.labels.length) * 0.65);
  const barGap = plotW / chart.labels.length;
  const zeroY = PADDING.top + toY(0);

  return (
    <figure className="not-prose my-8 rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="bg-slate-50 border-b border-slate-200 px-5 py-3">
        <p className="text-sm font-semibold text-slate-800">{chart.title}</p>
        {chart.timeRange && (
          <p className="text-xs text-slate-500 mt-0.5">{chart.timeRange}</p>
        )}
      </div>
      <div className="bg-white px-4 py-4 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }} aria-label={chart.title}>
          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const y = PADDING.top + f * plotH;
            const v = axisMax - f * axisRange;
            return (
              <g key={f}>
                <line x1={PADDING.left} y1={y} x2={W - PADDING.right} y2={y} stroke={GRID} strokeWidth="1" />
                <text x={PADDING.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill={AXIS}>
                  {formatValue(v)}
                </text>
              </g>
            );
          })}

          {/* Zero baseline (visible for charts with negative values) */}
          {axisMin < 0 && (
            <line x1={PADDING.left} y1={zeroY} x2={W - PADDING.right} y2={zeroY}
              stroke={AXIS} strokeWidth="1.5" />
          )}

          {/* Bars */}
          {chart.values.map((v, i) => {
            const barTop = PADDING.top + toY(Math.max(0, v));
            const barBot = PADDING.top + toY(Math.min(0, v));
            const bH = Math.max(2, barBot - barTop);
            const x = PADDING.left + i * barGap + (barGap - barW) / 2;
            const isNeg = v < 0;
            return (
              <rect
                key={i} x={x} y={barTop}
                width={barW} height={bH}
                fill={isNeg ? "#f87171" : ACCENT}
                rx="2" opacity="0.85"
              />
            );
          })}

          {/* X labels */}
          {chart.labels.map((label, i) => {
            if (!showLabel(i)) return null;
            const x = PADDING.left + i * barGap + barGap / 2;
            return (
              <text key={i} x={x} y={H - 10} textAnchor="middle" fontSize="10" fill={TEXT}>
                {formatXLabel(label)}
              </text>
            );
          })}
        </svg>
      </div>
      {chart.source && (
        <div className="bg-slate-50 border-t border-slate-200 px-5 py-2 text-[10px] text-slate-400">
          Source: {chart.source}
        </div>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// NewsKeyDataInline
// Renders KeyDataPoints as an inline grid within the article body.
// ---------------------------------------------------------------------------

interface NewsKeyDataInlineProps {
  dataPoints: KeyDataPoint[];
}

export function NewsKeyDataInline({ dataPoints }: NewsKeyDataInlineProps) {
  if (!dataPoints.length) return null;
  return (
    <div className="not-prose my-8 rounded-xl bg-navy-900 overflow-hidden">
      <div className="px-5 py-3 border-b border-white/10">
        <p className="text-[10px] font-bold tracking-widest uppercase text-white/50">Key Data</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y divide-white/10">
        {dataPoints.map((dp, i) => (
          <div key={i} className="px-4 py-3.5">
            <p className="text-white/40 text-[9px] font-semibold tracking-wider uppercase mb-0.5">
              {dp.label}
            </p>
            <div className="flex items-baseline gap-1.5">
              <span className="text-white font-bold text-base">{dp.value}</span>
              {dp.change && (
                <span className={`text-xs font-semibold ${dp.change.startsWith("-") ? "text-red-400" : "text-accent-400"}`}>
                  {dp.change}
                </span>
              )}
            </div>
            {dp.source && <p className="text-white/25 text-[9px] mt-0.5">{dp.source}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
