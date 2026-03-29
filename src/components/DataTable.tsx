export type DataTableVariant =
  | "airline-returns"
  | "airline-profitability"
  | "nxt-peer-comparison"
  | "nxt-valuation"
  | "fslr-valuation"
  | "nxt-earnings-beat"
  | "salt-rates"
  | "nxt-market-share"
  | "siri-valuation-summary"
  | "siri-reverse-dcf";

// Cell type — string = plain, object = styled
type CellType = "default" | "accent" | "pos" | "neg" | "hi" | "muted";
type Cell = string | { text: string; type?: CellType };

const getText = (c: Cell) => (typeof c === "string" ? c : c.text);
const getType = (c: Cell): CellType =>
  typeof c === "string" ? "default" : (c.type ?? "default");

function cellCls(type: CellType, isHeader: boolean): string {
  if (isHeader) {
    if (type === "accent") return "bg-accent-500 text-white";
    return "bg-navy-900 text-white";
  }
  switch (type) {
    case "hi":     return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold";
    case "pos":    return "text-emerald-600 dark:text-emerald-400 font-semibold";
    case "neg":    return "text-red-500 dark:text-red-400";
    case "muted":  return "text-text-light";
    default:       return "";
  }
}

interface TableConfig {
  title: string;
  headers: Cell[];
  rows: Cell[][];
  caption?: string;
}

const TABLES: Record<Exclude<DataTableVariant, "nxt-market-share">, TableConfig> = {
  "airline-returns": {
    title: "Airline Stocks vs. the S&P 500 — Annualized Returns",
    headers: ["Years", "DAL", "UAL", "LUV", "AAL", "Mean", { text: "S&P 500", type: "accent" }],
    rows: [
      ["5 yr", "11.99%", "18.08%", "0.66%", { text: "-2.68%", type: "neg" }, "7.01%", { text: "13.78%", type: "hi" }],
      ["10 yr", "2.90%", "4.13%", "1.17%", { text: "-11.34%", type: "neg" }, { text: "-0.78%", type: "neg" }, { text: "11.10%", type: "hi" }],
      ["15 yr", "10.92%", "9.43%", "8.56%", "2.29%", "7.80%", { text: "12.35%", type: "hi" }],
      ["20 yr", { text: "—", type: "muted" }, { text: "—", type: "muted" }, "5.20%", { text: "—", type: "muted" }, "5.20%", { text: "8.34%", type: "hi" }],
      ["25 yr", { text: "—", type: "muted" }, { text: "—", type: "muted" }, "4.57%", { text: "—", type: "muted" }, "4.57%", { text: "5.78%", type: "hi" }],
      ["30 yr", { text: "—", type: "muted" }, { text: "—", type: "muted" }, "7.28%", { text: "—", type: "muted" }, "7.28%", { text: "9.01%", type: "hi" }],
    ],
  },
  "airline-profitability": {
    title: "Airline Profitability Ratios",
    headers: ["Metric", "DAL", "UAL", "LUV", "AAL", "Mean"],
    rows: [
      ["Operating Margin", { text: "9.73%", type: "pos" }, { text: "8.93%", type: "pos" }, "1.17%", "4.82%", "6.16%"],
      ["Net Profit Margin", { text: "5.61%", type: "pos" }, { text: "5.52%", type: "pos" }, "1.69%", "1.56%", "3.59%"],
    ],
  },
  "nxt-peer-comparison": {
    title: "NEXTracker vs. Array Technologies — FY2024",
    headers: ["Metric", { text: "NEXTracker", type: "accent" }, "Array Technologies"],
    rows: [
      ["FY24 Revenue", { text: "$2.5B", type: "hi" }, "$1.0B"],
      ["Net Income / (Loss)", { text: "$496M", type: "hi" }, { text: "($240M)", type: "neg" }],
      ["Debt-to-Equity", { text: "15%", type: "hi" }, { text: "574%", type: "neg" }],
      ["Times Interest Earned", { text: "42x", type: "hi" }, { text: "N/A", type: "muted" }],
    ],
  },
  "nxt-valuation": {
    title: "NEXTracker — Valuation Summary",
    headers: ["Valuation Model", "Implied Value"],
    rows: [
      ["DCF (10% CAGR, 3% LTGR, 13.14% WACC)", { text: "$67/share", type: "pos" }],
      ["P/E Multiple (First Solar peer)", { text: "$66/share", type: "pos" }],
    ],
    caption: "Both models converge around $66–$67/share, supporting the $70 price target.",
  },
  "fslr-valuation": {
    title: "First Solar — Multi-Method Valuation",
    headers: ["Valuation Method", "Implied Discount to Fair Value"],
    rows: [
      ["DCF (4% LTGR, 11.53% WACC)", { text: "52% undervalued", type: "pos" }],
      ["EV / EBITDA (vs. NEXTracker peer)", { text: "38% undervalued", type: "pos" }],
      ["P/E Multiple", { text: "18% undervalued", type: "pos" }],
      ["Price to Cash Flow", { text: "29% undervalued", type: "pos" }],
    ],
    caption: "All four methods demonstrate First Solar is trading below fair value at $126/share.",
  },
  "nxt-earnings-beat": {
    title: "NEXTracker — Q4 FY2025 Earnings Beat",
    headers: ["Metric", "Reported", "Estimate", { text: "Beat", type: "accent" }],
    rows: [
      ["Revenue", "$924.3M", "$830.5M", { text: "+11%", type: "pos" }],
      ["Adjusted EPS", "$1.29", "$0.98", { text: "+32%", type: "pos" }],
      ["Adjusted EBITDA", "$242.5M", "$194.8M", { text: "+25%", type: "pos" }],
    ],
  },
  "salt-rates": {
    title: "High-Tax States Benefiting from SALT Expansion",
    headers: ["State", "Top Income Tax Rate"],
    rows: [
      ["California", "13.3%"],
      ["Hawaii", "11.0%"],
      ["New Jersey", "10.75%"],
      ["Oregon", "9.9%"],
      ["Minnesota", "9.85%"],
      ["New York", "8.82%"],
    ],
    caption: "SALT deduction cap increases from $10,000 to $40,000 starting 2025, reverting to $10,000 in 2030.",
  },
  "siri-valuation-summary": {
    title: "SiriusXM — DCF Valuation Summary",
    headers: ["Metric", "Value"],
    rows: [
      ["Current Share Price", "$22"],
      ["Implied Share Price (DCF)", { text: "$39", type: "pos" }],
      ["Upside to Fair Value", { text: "77%", type: "pos" }],
      ["WACC", "7.0%"],
      ["Terminal Growth Rate", "0.0%"],
      ["Revenue Growth Assumption", "Declining (−1.5% → 0%)"],
      ["EBIT Margin", "21.5%"],
    ],
    caption: "Base case assumes revenue declines of 1.5% tapering to 0% over a 5-year forecast period — a deliberately conservative assumption.",
  },
  "siri-reverse-dcf": {
    title: "SiriusXM — Reverse DCF: What the Market Is Pricing In",
    headers: ["Metric", "Market-Implied Value"],
    rows: [
      ["Current Share Price", "$22"],
      ["Implied Terminal Growth Rate (at 7.0% WACC)", { text: "−4.6%", type: "neg" }],
      ["Market Assumption", { text: "Perpetual cash flow decline", type: "neg" }],
      ["My Base Case TGR", { text: "0.0%", type: "pos" }],
      ["Difference", { text: "4.6 percentage points", type: "hi" }],
    ],
    caption: "The reverse DCF reveals the market is pricing in a permanent cash flow contraction of nearly 5% per year — far more pessimistic than even the most bearish fundamental outlook.",
  },
};

// Market share horizontal-bar layout
const MARKET_SHARE = [
  { name: "NEXTracker", pct: 23, highlight: true },
  { name: "Array", pct: 16 },
  { name: "GameChange", pct: 12 },
  { name: "PV Hardware", pct: 10 },
  { name: "Arctech", pct: 9 },
  { name: "TrinaSolar", pct: 6 },
  { name: "Soltec", pct: 6 },
  { name: "Solar Steel", pct: 5 },
  { name: "Axial", pct: 4 },
  { name: "Ideametec", pct: 3 },
  { name: "JSolar", pct: 3 },
  { name: "Antaisolar", pct: 2 },
  { name: "All Others", pct: 1 },
];

function StandardTable({ cfg }: { cfg: TableConfig }) {
  return (
    <div className="not-prose my-8 rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-5 py-4 bg-surface-2 border-b border-border">
        <p className="text-sm font-semibold text-text">{cfg.title}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {cfg.headers.map((cell, ci) => (
                <th
                  key={ci}
                  className={`px-4 py-3 text-left text-xs font-semibold tracking-wide whitespace-nowrap border-b border-border ${cellCls(getType(cell), true)}`}
                >
                  {getText(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cfg.rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? "bg-card" : "bg-surface-2/60"}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`px-4 py-3 border-b border-border whitespace-nowrap tabular-nums ${
                      ci === 0 ? "font-medium text-text" : "text-center"
                    } ${cellCls(getType(cell), false)}`}
                  >
                    {getText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cfg.caption && (
        <div className="bg-surface-2 border-t border-border px-5 py-2.5 text-[11px] text-text-light">
          {cfg.caption}
        </div>
      )}
    </div>
  );
}

function MarketShareTable() {
  const max = MARKET_SHARE[0].pct;
  return (
    <div className="not-prose my-8 rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-5 py-4 bg-surface-2 border-b border-border">
        <p className="text-sm font-semibold text-text">
          Global PV Tracker Market Share by Shipments, 2023
        </p>
      </div>
      <div className="bg-card divide-y divide-border">
        {MARKET_SHARE.map((item, i) => (
          <div key={i} className="flex items-center gap-3 px-5 py-2.5">
            <span
              className={`text-xs font-medium w-28 flex-shrink-0 ${
                item.highlight ? "text-emerald-700 dark:text-emerald-400 font-semibold" : "text-text-muted"
              }`}
            >
              {item.name}
            </span>
            <div className="flex-1 h-5 bg-surface-2 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(item.pct / max) * 100}%`,
                  backgroundColor: item.highlight ? "#22C55E" : "#94A3B8",
                }}
              />
            </div>
            <span
              className={`text-xs font-semibold tabular-nums w-8 text-right flex-shrink-0 ${
                item.highlight ? "text-emerald-700 dark:text-emerald-400" : "text-text-muted"
              }`}
            >
              {item.pct}%
            </span>
          </div>
        ))}
      </div>
      <div className="bg-surface-2 border-t border-border px-5 py-2.5 text-[11px] text-text-light">
        Total global shipments: 92 GW. Source: Wood Mackenzie.
      </div>
    </div>
  );
}

export default function DataTable({ variant }: { variant: DataTableVariant }) {
  if (variant === "nxt-market-share") return <MarketShareTable />;
  return <StandardTable cfg={TABLES[variant]} />;
}
