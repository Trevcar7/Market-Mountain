import { ChartDataset, ChartSeries, KeyDataPoint } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// NewsInlineChart
// Renders a ChartDataset inline within an article body.
// Pure SVG — no external charting library required.
//
// Design standard (institutional, March 2026):
//   • Single-series: green accent line with gradient fill + endpoint callout
//   • Multi-series: multiple colored lines with legend (no area fill)
//     — used for stock vs index comparisons (normalized to % change)
//   • Reference lines, bar charts, and editorial captions as before
// ---------------------------------------------------------------------------

interface NewsInlineChartProps {
  chart: ChartDataset;
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Palette for multi-series charts — institutional, high contrast
const SERIES_COLORS = ["#22C55E", "#64748b", "#f59e0b", "#8b5cf6", "#ef4444"];

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
    }
  }
  return result;
}


export function NewsInlineChart({ chart }: NewsInlineChartProps) {
  const isMultiSeries = chart.series && chart.series.length > 1;

  const W = 600;
  const H = isMultiSeries ? 250 : 220; // Taller for legend
  const PADDING = { top: 28, right: isMultiSeries ? 52 : 20, bottom: 44, left: 52 };
  const plotW = W - PADDING.left - PADDING.right;
  const plotH = H - PADDING.top - PADDING.bottom - (isMultiSeries ? 20 : 0);

  // ── Determine data bounds ─────────────────────────────────────────────────
  let allValues: number[];
  if (isMultiSeries && chart.series) {
    allValues = chart.series.flatMap((s) => s.values);
  } else {
    allValues = chart.values;
  }

  // Guard against empty or NaN-poisoned data
  allValues = allValues.filter((v) => typeof v === "number" && !isNaN(v));
  if (allValues.length === 0) return null;

  const dataMin = Math.min(...allValues);
  const dataMax = Math.max(...allValues);
  const dataRange = dataMax - dataMin || 1;

  let axisMin: number;
  let axisMax: number;

  if (chart.type === "bar") {
    axisMin = Math.min(0, dataMin);
    axisMax = Math.max(0, dataMax) + dataRange * 0.15;
  } else {
    const pad = dataRange * 0.22;
    axisMin = Math.max(dataMin < 0 ? dataMin - pad : 0, dataMin - pad);
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
    if (unit === "pp") return `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
    if (unit === "Points") return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);
    if (unit === "$/bbl") return `$${v.toFixed(0)}`;
    if (unit === "$B") return `$${v.toFixed(1)}B`;
    if (unit === "$") return `$${v.toFixed(2)}`;
    return `${v.toFixed(2)}`;
  };

  const ACCENT = "#22C55E";
  const GRID = "var(--chart-grid, #e2e8f0)";
  const AXIS = "var(--chart-axis, #94a3b8)";
  const TEXT = "var(--chart-text, #64748b)";
  const REF_COLOR = "var(--chart-axis, #94a3b8)";

  const maxLabels = 7;
  const labelStep = chart.labels.length > maxLabels ? Math.ceil(chart.labels.length / maxLabels) : 1;
  const showLabel = (i: number) =>
    i === 0 || i === chart.labels.length - 1 || i % labelStep === 0;

  const gradientId = `fill-${chart.title.replace(/\W/g, "")}`;

  // ── Shared chart chrome (grid, x-axis labels, reference line) ─────────────
  const renderGrid = () => (
    <>
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
    </>
  );

  const renderXLabels = () => {
    const displayLabels = buildDisplayLabels(chart.labels, showLabel);
    return chart.labels.map((_, i) => {
      const txt = displayLabels.get(i);
      if (txt === undefined) return null;
      const x = PADDING.left + i * xStep;
      return (
        <text key={i} x={x} y={H - (isMultiSeries ? 30 : 10)} textAnchor="middle" fontSize="10" fill={TEXT}>
          {txt}
        </text>
      );
    });
  };

  const renderRefLine = () => {
    if (chart.referenceValue === undefined) return null;
    const refY = PADDING.top + toY(chart.referenceValue);
    if (refY < PADDING.top || refY > PADDING.top + plotH) return null;
    return (
      <g>
        <line x1={PADDING.left} y1={refY} x2={W - PADDING.right} y2={refY}
          stroke={REF_COLOR} strokeWidth="1.5" strokeDasharray="5 4" />
        {chart.referenceLabel && (
          <text x={PADDING.left + 6} y={refY - 5} fontSize="9" fill={REF_COLOR}>
            {chart.referenceLabel}
          </text>
        )}
      </g>
    );
  };

  const renderChartHeader = () => (
    <div className="bg-surface-2 border-b border-border px-5 py-3">
      {chart.chartLabel && (
        <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-text-light mb-1">
          {chart.chartLabel}
        </p>
      )}
      <p className="text-sm font-semibold text-text">{chart.title}</p>
      {chart.timeRange && (
        <p className="text-xs text-text-muted mt-0.5">{chart.timeRange}</p>
      )}
    </div>
  );

  const renderChartFooter = () => {
    if (!chart.source && !chart.caption) return null;
    return (
      <div className="bg-surface-2 border-t border-border px-5 py-2.5 space-y-0.5">
        {chart.caption && (
          <p className="text-xs text-text-muted italic leading-relaxed">{chart.caption}</p>
        )}
        {chart.source && (
          <p className="text-[10px] text-text-light">Source: {chart.source}</p>
        )}
      </div>
    );
  };

  // ── MULTI-SERIES LINE CHART ───────────────────────────────────────────────
  if (chart.type === "line" && isMultiSeries && chart.series) {
    const legendY = H - 14;

    return (
      <figure className="not-prose my-8 rounded-xl border border-border overflow-hidden shadow-sm">
        {renderChartHeader()}
        <div className="bg-card px-4 py-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 280 }} aria-label={chart.title}>
            {renderGrid()}
            {renderRefLine()}
            {renderXLabels()}

            {/* Render each series */}
            {chart.series.map((series, si) => {
              const color = series.color ?? SERIES_COLORS[si % SERIES_COLORS.length];
              const points = series.values.map((v, i) => ({
                x: PADDING.left + i * xStep,
                y: PADDING.top + toY(v),
              }));
              const pathD = points
                .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                .join(" ");

              const lastPt = points[points.length - 1];
              const lastVal = series.values[series.values.length - 1];

              // Primary series (first) gets area fill
              const isPrimary = si === 0;

              return (
                <g key={si}>
                  {/* Area fill for primary series only */}
                  {isPrimary && (
                    <>
                      <defs>
                        <linearGradient id={`${gradientId}-${si}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={color} stopOpacity="0.10" />
                          <stop offset="100%" stopColor={color} stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <path
                        d={`${pathD} L ${lastPt.x.toFixed(1)} ${PADDING.top + plotH} L ${points[0].x.toFixed(1)} ${PADDING.top + plotH} Z`}
                        fill={`url(#${gradientId}-${si})`}
                      />
                    </>
                  )}

                  {/* Line */}
                  <path
                    d={pathD} fill="none"
                    stroke={color} strokeWidth={isPrimary ? 2.5 : 1.5}
                    strokeLinecap="round" strokeLinejoin="round"
                    strokeDasharray={isPrimary ? undefined : "6 3"}
                  />

                  {/* Endpoint dot + value with white halo for legibility */}
                  <circle cx={lastPt.x} cy={lastPt.y} r={4} fill="white" stroke={color} strokeWidth="2" />
                  <circle cx={lastPt.x} cy={lastPt.y} r={2} fill={color} />
                  {(() => {
                    // Position end labels: primary on left, secondary on right
                    // Clamp secondary labels to stay within the SVG viewbox
                    const rightEdge = W - 4;
                    let lx = lastPt.x - (si === 0 ? 4 : -4);
                    let anchor: "end" | "start" = si === 0 ? "end" : "start";
                    if (anchor === "start" && lx + 40 > rightEdge) {
                      lx = lastPt.x - 4;
                      anchor = "end";
                    }
                    const ly = lastPt.y - 14;
                    return (
                      <>
                        <text x={lx} y={ly} textAnchor={anchor} fontSize="10" fontWeight="700"
                          stroke="white" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke">
                          {formatValue(lastVal)}
                        </text>
                        <text x={lx} y={ly} textAnchor={anchor} fontSize="10" fontWeight="700" fill={color}>
                          {formatValue(lastVal)}
                        </text>
                      </>
                    );
                  })()}
                </g>
              );
            })}

            {/* Legend */}
            {chart.series.map((series, si) => {
              const color = series.color ?? SERIES_COLORS[si % SERIES_COLORS.length];
              const legendSpacing = W / (chart.series!.length + 1);
              const cx = legendSpacing * (si + 1);
              return (
                <g key={`legend-${si}`}>
                  <line x1={cx - 18} y1={legendY} x2={cx - 6} y2={legendY}
                    stroke={color} strokeWidth="2" strokeDasharray={si === 0 ? undefined : "4 2"} />
                  <circle cx={cx - 2} cy={legendY} r={2.5} fill={color} />
                  <text x={cx + 4} y={legendY + 3.5} fontSize="10" fill={TEXT} fontWeight="500">
                    {series.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        {renderChartFooter()}
      </figure>
    );
  }

  // ── SINGLE-SERIES LINE CHART ──────────────────────────────────────────────
  if (chart.type === "line") {
    const points = chart.values.map((v, i) => ({
      x: PADDING.left + i * xStep,
      y: PADDING.top + toY(v),
    }));
    const pathD = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");

    const baselineY = PADDING.top + plotH;
    const areaD =
      pathD +
      ` L ${points[points.length - 1].x.toFixed(1)} ${baselineY}` +
      ` L ${points[0].x.toFixed(1)} ${baselineY} Z`;

    const lastPt = points[points.length - 1];
    const lastVal = chart.values[chart.values.length - 1];

    const labelAnchor = lastPt.x > W * 0.75 ? "end" : "middle";
    const labelX = labelAnchor === "end" ? lastPt.x - 2 : lastPt.x;

    return (
      <figure className="not-prose my-8 rounded-xl border border-border overflow-hidden shadow-sm">
        {renderChartHeader()}
        <div className="bg-card px-4 py-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }} aria-label={chart.title}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity="0.12" />
                <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
              </linearGradient>
            </defs>

            {renderGrid()}
            {renderRefLine()}
            {renderXLabels()}

            <path d={areaD} fill={`url(#${gradientId})`} />
            <path d={pathD} fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

            {points.slice(0, -1).map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={2} fill={ACCENT} opacity="0.5" />
            ))}

            <circle cx={lastPt.x} cy={lastPt.y} r={5.5} fill="white" stroke={ACCENT} strokeWidth="2" />
            <circle cx={lastPt.x} cy={lastPt.y} r={2.5} fill={ACCENT} />

            {/* White halo behind label so trendline never cuts through text */}
            <text x={labelX} y={lastPt.y - 14} textAnchor={labelAnchor} fontSize="11" fontWeight="700"
              stroke="white" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke">
              ● {formatValue(lastVal)}
            </text>
            <text x={labelX} y={lastPt.y - 14} textAnchor={labelAnchor} fontSize="11" fontWeight="700" fill={ACCENT}>
              ● {formatValue(lastVal)}
            </text>
          </svg>
        </div>
        {renderChartFooter()}
      </figure>
    );
  }

  // ── BAR CHART ──────────────────────────────────────────────────────────────
  const barW = Math.max(4, (plotW / chart.labels.length) * 0.65);
  const barGap = plotW / chart.labels.length;
  const zeroY = PADDING.top + toY(0);

  return (
    <figure className="not-prose my-8 rounded-xl border border-border overflow-hidden shadow-sm">
      {renderChartHeader()}
      <div className="bg-card px-4 py-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }} aria-label={chart.title}>
          {renderGrid()}

          {axisMin < 0 && (
            <line x1={PADDING.left} y1={zeroY} x2={W - PADDING.right} y2={zeroY} stroke={AXIS} strokeWidth="1.5" />
          )}

          {chart.values.map((v, i) => {
            const barTop = PADDING.top + toY(Math.max(0, v));
            const barBot = PADDING.top + toY(Math.min(0, v));
            const bH = Math.max(2, barBot - barTop);
            const x = PADDING.left + i * barGap + (barGap - barW) / 2;
            const isNeg = v < 0;
            return (
              <rect key={i} x={x} y={barTop} width={barW} height={bH}
                fill={isNeg ? "#f87171" : ACCENT} rx="2" opacity="0.85" />
            );
          })}

          {(() => {
            const displayLabels = buildDisplayLabels(chart.labels, showLabel);
            return chart.labels.map((_, i) => {
              const txt = displayLabels.get(i);
              if (txt === undefined) return null;
              const x = PADDING.left + i * barGap + barGap / 2;
              return (
                <text key={i} x={x} y={H - 10} textAnchor="middle" fontSize="10" fill={TEXT}>{txt}</text>
              );
            });
          })()}
        </svg>
      </div>
      {renderChartFooter()}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// NewsKeyDataInline
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
