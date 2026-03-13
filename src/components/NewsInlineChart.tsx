import { ChartDataset, KeyDataPoint } from "@/lib/news-types";

// ---------------------------------------------------------------------------
// NewsInlineChart
// Renders a ChartDataset inline within an article body.
// Pure SVG — no external charting library required.
// ---------------------------------------------------------------------------

interface NewsInlineChartProps {
  chart: ChartDataset;
}

export function NewsInlineChart({ chart }: NewsInlineChartProps) {
  const W = 600;
  const H = 200;
  const PADDING = { top: 24, right: 16, bottom: 40, left: 48 };
  const plotW = W - PADDING.left - PADDING.right;
  const plotH = H - PADDING.top - PADDING.bottom;

  const max = Math.max(...chart.values, 0);
  const min = Math.min(...chart.values, 0);
  const range = max - min || 1;

  const xStep = plotW / Math.max(chart.labels.length - 1, 1);
  const toY = (v: number) => plotH - ((v - min) / range) * plotH;

  const formatValue = (v: number) => {
    const unit = chart.unit ?? "";
    if (unit === "%") return `${v.toFixed(1)}%`;
    if (unit === "$B") return `$${v.toFixed(1)}B`;
    if (unit === "$") return `$${v.toLocaleString()}`;
    return `${v.toFixed(2)}${unit}`;
  };

  const ACCENT = "#22C55E";
  const GRID = "#e2e8f0";
  const AXIS = "#94a3b8";
  const TEXT = "#64748b";

  // Thin labels — show first, last, and every Nth
  const labelStep = chart.labels.length > 8 ? Math.ceil(chart.labels.length / 6) : 1;
  const showLabel = (i: number) =>
    i === 0 || i === chart.labels.length - 1 || i % labelStep === 0;

  if (chart.type === "line") {
    const points = chart.values.map((v, i) => ({
      x: PADDING.left + i * xStep,
      y: PADDING.top + toY(v),
    }));
    const pathD = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");

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
            style={{ maxHeight: 220 }}
            aria-label={chart.title}
          >
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const y = PADDING.top + f * plotH;
              const v = max - f * range;
              return (
                <g key={f}>
                  <line x1={PADDING.left} y1={y} x2={W - PADDING.right} y2={y} stroke={GRID} strokeWidth="1" />
                  <text x={PADDING.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill={AXIS}>
                    {formatValue(v)}
                  </text>
                </g>
              );
            })}

            {/* X axis labels */}
            {chart.labels.map((label, i) => {
              if (!showLabel(i)) return null;
              const x = PADDING.left + i * xStep;
              return (
                <text key={i} x={x} y={H - 8} textAnchor="middle" fontSize="10" fill={TEXT}>
                  {label}
                </text>
              );
            })}

            {/* Line */}
            <path d={pathD} fill="none" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

            {/* Data points */}
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="3" fill={ACCENT} />
            ))}
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

  // Bar chart
  const barW = Math.max(4, (plotW / chart.labels.length) * 0.65);
  const barGap = plotW / chart.labels.length;

  return (
    <figure className="not-prose my-8 rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="bg-slate-50 border-b border-slate-200 px-5 py-3">
        <p className="text-sm font-semibold text-slate-800">{chart.title}</p>
        {chart.timeRange && (
          <p className="text-xs text-slate-500 mt-0.5">{chart.timeRange}</p>
        )}
      </div>
      <div className="bg-white px-4 py-4 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }} aria-label={chart.title}>
          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const y = PADDING.top + f * plotH;
            const v = max - f * range;
            return (
              <g key={f}>
                <line x1={PADDING.left} y1={y} x2={W - PADDING.right} y2={y} stroke={GRID} strokeWidth="1" />
                <text x={PADDING.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill={AXIS}>
                  {formatValue(v)}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {chart.values.map((v, i) => {
            const barH = Math.max(2, ((v - min) / range) * plotH);
            const x = PADDING.left + i * barGap + (barGap - barW) / 2;
            const y = PADDING.top + toY(v);
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={barW}
                height={barH}
                fill={ACCENT}
                rx="2"
                opacity="0.85"
              />
            );
          })}

          {/* X labels */}
          {chart.labels.map((label, i) => {
            if (!showLabel(i)) return null;
            const x = PADDING.left + i * barGap + barGap / 2;
            return (
              <text key={i} x={x} y={H - 8} textAnchor="middle" fontSize="10" fill={TEXT}>
                {label}
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
// Replaces the desktop-only sidebar.
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
