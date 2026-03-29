type WaterfallVariant = "siri-revenue-to-fcf";

interface WaterfallStep {
  label: string;
  value: number;
  type: "start" | "add" | "subtract" | "total";
}

interface WaterfallConfig {
  title: string;
  steps: WaterfallStep[];
  valFormat: (v: number) => string;
  color: string;
  darkColor: string;
  caption?: string;
}

const CHARTS: Record<WaterfallVariant, WaterfallConfig> = {
  "siri-revenue-to-fcf": {
    title: "SiriusXM FY2025: Revenue to Free Cash Flow Bridge ($B)",
    steps: [
      { label: "Revenue", value: 8.56, type: "start" },
      { label: "Content &\nRoyalties", value: -2.89, type: "subtract" },
      { label: "Satellite &\nTransmission", value: -0.85, type: "subtract" },
      { label: "Sales &\nMarketing", value: -1.12, type: "subtract" },
      { label: "G&A +\nOther Opex", value: -1.03, type: "subtract" },
      { label: "Adj.\nEBITDA", value: 2.67, type: "total" },
      { label: "D&A /\nCapex / Tax", value: -1.41, type: "subtract" },
      { label: "Free Cash\nFlow", value: 1.26, type: "total" },
    ],
    valFormat: (v) => `$${Math.abs(v).toFixed(2)}B`,
    color: "#0000EB",
    darkColor: "#818CF8",
    caption:
      "FY2025 approximate bridge from total revenue to free cash flow. Adj. EBITDA margin ~31%. FCF margin ~15%. Source: SiriusXM 10-K filings.",
  },
};

const CHART_HEIGHT = 220;
const BAR_AREA = 180;

export default function WaterfallChart({
  variant,
}: {
  variant: WaterfallVariant;
}) {
  const cfg = CHARTS[variant];
  const maxVal = Math.max(...cfg.steps.map((s) => s.value));

  // Compute running totals and bar positions
  const bars: {
    label: string;
    value: number;
    bottom: number;
    height: number;
    type: WaterfallStep["type"];
  }[] = [];
  let running = 0;

  for (const step of cfg.steps) {
    if (step.type === "start") {
      running = step.value;
      bars.push({
        label: step.label,
        value: step.value,
        bottom: 0,
        height: (step.value / maxVal) * BAR_AREA,
        type: step.type,
      });
    } else if (step.type === "subtract") {
      const absVal = Math.abs(step.value);
      const barH = (absVal / maxVal) * BAR_AREA;
      running += step.value;
      const bottomPx = (running / maxVal) * BAR_AREA;
      bars.push({
        label: step.label,
        value: step.value,
        bottom: bottomPx,
        height: barH,
        type: step.type,
      });
    } else if (step.type === "add") {
      const barH = (step.value / maxVal) * BAR_AREA;
      const bottomPx = (running / maxVal) * BAR_AREA;
      running += step.value;
      bars.push({
        label: step.label,
        value: step.value,
        bottom: bottomPx,
        height: barH,
        type: step.type,
      });
    } else {
      // total — show as grounded bar at running total
      bars.push({
        label: step.label,
        value: running,
        bottom: 0,
        height: (running / maxVal) * BAR_AREA,
        type: step.type,
      });
    }
  }

  return (
    <div className="not-prose my-8 rounded-xl border border-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-surface-2 border-b border-border">
        <p className="text-sm font-semibold text-text">{cfg.title}</p>
      </div>

      {/* Chart */}
      <div className="bg-card px-4 sm:px-6 pt-5 pb-3">
        <div
          className="relative flex items-end gap-1 sm:gap-2"
          style={{ height: `${CHART_HEIGHT}px` }}
        >
          {/* Grid lines */}
          {[0.25, 0.5, 0.75, 1.0].map((f) => (
            <div
              key={f}
              className="absolute left-0 right-0 border-t border-border/60"
              style={{ bottom: `${f * BAR_AREA}px` }}
            />
          ))}

          {/* Waterfall bars */}
          {bars.map((bar, i) => {
            const isNeg = bar.type === "subtract";
            const isTotal = bar.type === "total";
            const barColor = isNeg
              ? "#94A3B8"
              : isTotal
                ? cfg.color
                : cfg.color;

            return (
              <div
                key={i}
                className="relative z-10 flex flex-col items-center flex-1"
                style={{ height: `${CHART_HEIGHT - 20}px` }}
              >
                {/* Value label */}
                <div
                  className="flex flex-col items-center justify-end flex-1"
                  style={{ paddingBottom: `${bar.bottom + bar.height}px` }}
                >
                  <span
                    className="bar-label text-[9px] sm:text-[10px] font-semibold leading-none mb-1"
                    style={
                      {
                        color: isNeg ? "#94A3B8" : cfg.color,
                        "--lc-dk": isNeg ? "#CBD5E1" : cfg.darkColor,
                      } as React.CSSProperties
                    }
                  >
                    {isNeg ? "-" : ""}
                    {cfg.valFormat(bar.value)}
                  </span>
                </div>

                {/* Bar */}
                <div
                  style={{
                    position: "absolute",
                    bottom: `${bar.bottom + 20}px`,
                    height: `${Math.max(3, bar.height)}px`,
                    width: "100%",
                    maxWidth: "56px",
                    backgroundColor: barColor,
                    borderRadius: "3px 3px 0 0",
                    opacity: isNeg ? 0.45 : isTotal ? 1 : 1,
                  }}
                />

                {/* Connector line to next bar */}
                {i < bars.length - 1 && !isTotal && (
                  <div
                    className="absolute border-t border-dashed border-text-light/40"
                    style={{
                      bottom: `${(isNeg ? bar.bottom : bar.bottom + bar.height) + 20}px`,
                      right: "-50%",
                      width: "100%",
                    }}
                  />
                )}

                {/* Category label */}
                <span className="text-[9px] sm:text-[10px] font-medium text-text-muted text-center whitespace-pre-line leading-tight absolute bottom-0">
                  {bar.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Caption */}
      {cfg.caption && (
        <div className="bg-surface-2 border-t border-border px-5 py-2.5 text-[11px] text-text-light">
          {cfg.caption}
        </div>
      )}
    </div>
  );
}
