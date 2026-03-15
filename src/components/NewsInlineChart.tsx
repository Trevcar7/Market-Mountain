import { ChartDataset, KeyDataPoint } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// NewsInlineChart
// Renders a ChartDataset inline within an article body.
// Pure SVG — no external charting library required.
//
// Design standard (institutional, March 2026):
//   • chartLabel rendered as a small category header above the chart title
//     (e.g., "ENERGY MARKETS", "RATES", "MARKET CONTEXT")
//   • Tight y-axis anchored to data range for line charts (macro scale)
//   • Zero-based y-axis for bar charts
//   • 2px stroke — clean and lightweight
//   • Subtle gradient area fill beneath the line
//   • Final data point: larger dot with white ring + bold value callout
//   • Optional reference line (e.g., Fed 2% target, $100 threshold)
//   • YYYY-MM-DD date labels formatted as "Mar '25"
// ---------------------------------------------------------------------------

interface NewsInlineChartProps {
  chart: ChartDataset;
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Format a single label into a base display string (month + year). */
function baseFormatLabel(label: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const [year, month] = label.split("-");
    return `${MONTHS_SHORT[parseInt(month, 10) - 1]} '${year.slice(2)}`;
  }
  if (/^\d{4}-\d{2}$/.test(label)) {
    const [year, month] = label.split("-");
    return `${MONTHS_SHORT[parseInt(month, 10) - 1]} '${year.slice(2)}`;
  }
  const longMonthMatch = label.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (longMonthMatch) {
    return `${longMonthMatch[1].slice(0, 3)} '${longMonthMatch[2].slice(2)}`;
  }
  return label;
}

/**
 * Pre-compute deduplicated x-axis display labels for visible ticks.
 *
 * Problem: 90 daily DGS10 points spanning 4 months produce many dates in the
 * same month, all formatting to "Mar '26" — creating 5+ identical tick labels.
 *
 * Fix: first occurrence of each "Mon 'YY" gets the full label; subsequent
 * occurrences in the same month show just the day number (e.g., "15").
 * Monthly-series repeats (YYYY-MM) are skipped entirely.
 */
function buildDisplayLabels(
  labels: string[],
  showLabel: (i: number) => boolean
): Map<number, string> {
  const seen = new Set<string>();
  const result = new Map<number, string>();

  for (let i = 0; i < labels.length; i++) {
    if (!showLabel(i)) continue;

    const base = baseFormatLabel(labels[i]);

    if (!seen.has(base)) {
      seen.add(base);
      result.set(i, base);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(labels[i])) {
      // Daily series: show just the day number for repeated months
      const day = parseInt(labels[i].split("-")[2], 10);
      result.set(i, String(day));
    }
    // Monthly series with duplicate: omit label (don't add to map)
  }

  return result;
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
  let axisMin: number;
  let axisMax: number;

  if (chart.type === "bar") {
    axisMin = Math.min(0, dataMin);
    axisMax = Math.max(0, dataMax) + dataRange * 0.15;
  } else {
    const pad = dataRange * 0.22;
    axisMin = Math.max(0, dataMin - pad);
    axisMax = dataMax + pad;

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
    if (unit === "%") return `${v.toFixed(2)}%`;
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

  // Show max 7 labels, evenly spaced. For 90 daily points: step=15, ~6 labels + endpoints.
  const maxLabels = 7;
  const labelStep = chart.labels.length > maxLabels ? Math.ceil(chart.labels.length / maxLabels) : 1;
  const showLabel = (i: number) =>
    i === 0 || i === chart.labels.length - 1 || i % labelStep === 0;

  // Gradient fill ID — unique per chart to avoid SVG conflicts when multiple charts on page
  const gradientId = `fill-${chart.title.replace(/\W/g, "")}`;

  // ── LINE CHART ─────────────────────────────────────────────────────────────
  if (chart.type === "line") {
    const points = chart.values.map((v, i) => ({
      x: PADDING.left + i * xStep,
      y: PADDING.top + toY(v),
    }));
    const pathD = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");

    // Area fill path: line + close down to baseline
    const baselineY = PADDING.top + plotH;
    const areaD =
      pathD +
      ` L ${points[points.length - 1].x.toFixed(1)} ${baselineY}` +
      ` L ${points[0].x.toFixed(1)} ${baselineY} Z`;

    const lastPt = points[points.length - 1];
    const lastVal = chart.values[chart.values.length - 1];

    const refY =
      chart.referenceValue !== undefined
        ? PADDING.top + toY(chart.referenceValue)
        : null;
    const refInBounds =
      refY !== null && refY >= PADDING.top && refY <= PADDING.top + plotH;

    // Label anchor: shift left if near right edge
    const labelAnchor = lastPt.x > W * 0.75 ? "end" : "middle";
    const labelX = labelAnchor === "end" ? lastPt.x - 2 : lastPt.x;

    return (
      <figure className="not-prose my-8 rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        {/* Chart header */}
        <div className="bg-slate-50 border-b border-slate-200 px-5 py-3">
          {chart.chartLabel && (
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-slate-400 mb-1">
              {chart.chartLabel}
            </p>
          )}
          <p className="text-sm font-semibold text-slate-800">{chart.title}</p>
          {chart.timeRange && (
            <p className="text-xs text-slate-500 mt-0.5">{chart.timeRange}</p>
          )}
        </div>
        <div className="bg-white px-4 py-4">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ maxHeight: 240 }}
            aria-label={chart.title}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity="0.12" />
                <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
              </linearGradient>
            </defs>

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
                  <text x={PADDING.left + 6} y={refY - 5} fontSize="9" fill={REF_COLOR}>
                    {chart.referenceLabel}
                  </text>
                )}
              </g>
            )}

            {/* X axis labels — deduplicated via buildDisplayLabels */}
            {(() => {
              const displayLabels = buildDisplayLabels(chart.labels, showLabel);
              return chart.labels.map((label, i) => {
                const txt = displayLabels.get(i);
                if (txt === undefined) return null;
                const x = PADDING.left + i * xStep;
                return (
                  <text key={i} x={x} y={H - 10} textAnchor="middle" fontSize="10" fill={TEXT}>
                    {txt}
                  </text>
                );
              });
            })()}

            {/* Gradient area fill */}
            <path d={areaD} fill={`url(#${gradientId})`} />

            {/* Line — 2px stroke */}
            <path
              d={pathD} fill="none"
              stroke={ACCENT} strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
            />

            {/* Intermediate data points — small dots */}
            {points.slice(0, -1).map((p, i) => (
              <circle
                key={i} cx={p.x} cy={p.y}
                r={2} fill={ACCENT} opacity="0.5"
              />
            ))}

            {/* Final data point — emphasized with white ring */}
            <circle
              cx={lastPt.x} cy={lastPt.y}
              r={5.5} fill="white" stroke={ACCENT} strokeWidth="2"
            />
            <circle cx={lastPt.x} cy={lastPt.y} r={2.5} fill={ACCENT} />

            {/* Latest value callout — anchored to final point */}
            <text
              x={labelX} y={lastPt.y - 13}
              textAnchor={labelAnchor}
              fontSize="11" fontWeight="700" fill={ACCENT}
            >
              ● {formatValue(lastVal)}
            </text>
          </svg>
        </div>
        {(chart.source || chart.caption) && (
          <div className="bg-slate-50 border-t border-slate-200 px-5 py-2.5 space-y-0.5">
            {chart.caption && (
              <p className="text-xs text-slate-600 italic leading-relaxed">{chart.caption}</p>
            )}
            {chart.source && (
              <p className="text-[10px] text-slate-400">Source: {chart.source}</p>
            )}
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
        {chart.chartLabel && (
          <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-slate-400 mb-1">
            {chart.chartLabel}
          </p>
        )}
        <p className="text-sm font-semibold text-slate-800">{chart.title}</p>
        {chart.timeRange && (
          <p className="text-xs text-slate-500 mt-0.5">{chart.timeRange}</p>
        )}
      </div>
      <div className="bg-white px-4 py-4">
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

          {/* Zero baseline */}
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

          {/* X labels — deduplicated via buildDisplayLabels */}
          {(() => {
            const displayLabels = buildDisplayLabels(chart.labels, showLabel);
            return chart.labels.map((label, i) => {
              const txt = displayLabels.get(i);
              if (txt === undefined) return null;
              const x = PADDING.left + i * barGap + barGap / 2;
              return (
                <text key={i} x={x} y={H - 10} textAnchor="middle" fontSize="10" fill={TEXT}>
                  {txt}
                </text>
              );
            });
          })()}
        </svg>
      </div>
      {(chart.source || chart.caption) && (
        <div className="bg-slate-50 border-t border-slate-200 px-5 py-2.5 space-y-0.5">
          {chart.caption && (
            <p className="text-xs text-slate-600 italic leading-relaxed">{chart.caption}</p>
          )}
          {chart.source && (
            <p className="text-[10px] text-slate-400">Source: {chart.source}</p>
          )}
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
            <p className="text-white/40 text-[10px] font-semibold tracking-wider uppercase mb-0.5">
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
            {dp.source && <p className="text-white/25 text-[10px] mt-0.5">{dp.source}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
