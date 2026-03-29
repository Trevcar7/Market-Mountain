type DCFVariant = "nextracker" | "firstsolar" | "sprouts" | "siriusxm";

interface DCFConfig {
  baseCaseValue: number;
  currentPrice: number;
  waccValues: string[];
  ltgrValues: string[];
  data: number[][];
  baseCaseRow: number;
  baseCaseCol: number;
}

/** Publication dates for each variant — used in "as of" caption */
const PUBLISH_DATES: Record<DCFVariant, string> = {
  nextracker: "May 2025",
  firstsolar: "Mar 2025",
  sprouts: "Nov 2025",
  siriusxm: "Mar 2026",
};

const CONFIGS: Record<DCFVariant, DCFConfig> = {
  nextracker: {
    baseCaseValue: 67,
    currentPrice: 50,
    waccValues: ["11.14%", "12.14%", "13.14%", "14.14%", "15.14%"],
    ltgrValues: ["2.0%", "2.5%", "3.0%", "3.5%", "4.0%"],
    data: [
      [79, 70, 62, 56, 51],
      [83, 73, 65, 58, 52],
      [88, 76, 67, 60, 54],
      [93, 80, 70, 62, 56],
      [98, 84, 74, 65, 58],
    ],
    baseCaseRow: 2,
    baseCaseCol: 2,
  },
  firstsolar: {
    baseCaseValue: 190,
    currentPrice: 126,
    waccValues: ["9.53%", "10.53%", "11.53%", "12.53%", "13.53%"],
    ltgrValues: ["2.00%", "3.00%", "4.00%", "5.00%", "6.00%"],
    data: [
      [206, 177, 155, 137, 122],
      [235, 199, 171, 150, 132],
      [274, 227, 190, 165, 144],
      [331, 264, 219, 185, 160],
      [419, 319, 255, 211, 179],
    ],
    baseCaseRow: 2,
    baseCaseCol: 2,
  },
  sprouts: {
    baseCaseValue: 153,
    currentPrice: 79,
    waccValues: ["5.24%", "6.24%", "7.24%", "8.24%", "9.24%"],
    ltgrValues: ["0.5%", "1.0%", "2.0%", "3.0%", "3.5%"],
    data: [
      [169, 140, 119, 104,  92],
      [189, 153, 129, 111,  97],
      [247, 189, 153, 129, 111],
      [358, 247, 189, 153, 129],
      [461, 293, 214, 169, 140],
    ],
    baseCaseRow: 2,
    baseCaseCol: 2,
  },
  siriusxm: {
    baseCaseValue: 39,
    currentPrice: 22,
    waccValues: ["5.0%", "6.0%", "7.0%", "8.0%", "9.0%"],
    ltgrValues: ["-1.0%", "-0.5%", "0.0%", "0.5%", "1.0%"],
    data: [
      [54, 42, 33, 26, 21],
      [59, 46, 36, 28, 23],
      [66, 50, 39, 31, 24],
      [74, 56, 43, 34, 26],
      [85, 62, 47, 37, 29],
    ],
    baseCaseRow: 2,
    baseCaseCol: 2,
  },
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function heatColor(t: number): string {
  const s = Math.max(0, Math.min(1, t));
  let r: number, g: number, b: number;
  if (s < 0.25) {
    const p = s / 0.25;
    r = lerp(232, 244, p); g = lerp(100, 162, p); b = lerp(90, 107, p);
  } else if (s < 0.5) {
    const p = (s - 0.25) / 0.25;
    r = lerp(244, 245, p); g = lerp(162, 212, p); b = lerp(107, 122, p);
  } else if (s < 0.75) {
    const p = (s - 0.5) / 0.25;
    r = lerp(245, 200, p); g = lerp(212, 220, p); b = lerp(122, 132, p);
  } else {
    const p = (s - 0.75) / 0.25;
    r = lerp(200, 134, p); g = lerp(220, 188, p); b = lerp(132, 97, p);
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

export default function DCFHeatmap({ variant }: { variant: DCFVariant }) {
  const cfg = CONFIGS[variant];
  const flat = cfg.data.flat();
  const min = Math.min(...flat);
  const max = Math.max(...flat);

  return (
    <div className="my-8 overflow-x-auto rounded-xl border border-border shadow-sm not-prose">
      <table className="w-full border-collapse text-sm">
        <thead>
          {/* WACC title row */}
          <tr>
            <th colSpan={2} className="bg-surface-2 border-b border-r border-border p-2" />
            <th
              colSpan={cfg.waccValues.length}
              className="bg-surface-2 border-b border-border py-2.5 text-center text-[11px] font-bold tracking-widest uppercase text-text-muted"
            >
              WACC
            </th>
          </tr>
          {/* Column header row */}
          <tr>
            <th className="bg-surface-2 border-b border-r border-border w-7 p-0" />
            <th className="bg-surface-2 border-b border-r border-border px-3 py-2 text-right text-[11px] font-semibold text-text-light whitespace-nowrap">
              ${cfg.baseCaseValue}
            </th>
            {cfg.waccValues.map((w) => (
              <th
                key={w}
                className="bg-surface-2 border-b border-r border-border px-2 sm:px-4 py-2 sm:py-2.5 text-center text-[11px] sm:text-xs font-semibold text-text"
              >
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cfg.data.map((row, ri) => (
            <tr key={ri}>
              {/* Rotated LTGR label — spans all data rows */}
              {ri === 0 && (
                <td
                  rowSpan={cfg.data.length}
                  className="bg-surface-2 border-r border-border text-center text-[11px] font-bold tracking-widest uppercase text-text-muted w-7"
                  style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                >
                  LTGR
                </td>
              )}
              {/* LTGR percentage */}
              <td className="bg-surface-2 border-b border-r border-border px-2 sm:px-3 py-2.5 sm:py-3.5 text-right text-[11px] sm:text-xs font-semibold text-text whitespace-nowrap">
                {cfg.ltgrValues[ri]}
              </td>
              {/* Heat map data cells */}
              {row.map((val, ci) => {
                const isBase = ri === cfg.baseCaseRow && ci === cfg.baseCaseCol;
                const t = (val - min) / (max - min);
                return (
                  <td
                    key={ci}
                    className="border-b border-r border-border py-2.5 sm:py-3.5 px-2 sm:px-4 text-center text-xs sm:text-sm font-bold"
                    style={{
                      backgroundColor: heatColor(t),
                      color: "rgba(10,22,40,0.82)",
                      ...(isBase
                        ? { boxShadow: "inset 0 0 0 2.5px rgba(10,22,40,0.5)" }
                        : {}),
                    }}
                  >
                    ${val}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Caption bar */}
      <div className="bg-surface-2 border-t border-border px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-light">
        <span>
          Base case:{" "}
          <span className="font-semibold text-text-muted">
            {cfg.waccValues[cfg.baseCaseCol]} WACC · {cfg.ltgrValues[cfg.baseCaseRow]} LTGR → ${cfg.baseCaseValue}/share
          </span>
        </span>
        <span>Price at publication: ${cfg.currentPrice} ({PUBLISH_DATES[variant]})</span>
      </div>
    </div>
  );
}
