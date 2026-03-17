"use client";

import { useState, useEffect, useRef } from "react";
import type { KeyDataPoint } from "@/lib/news-types";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function isMarketHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

  if (weekday === "Sat" || weekday === "Sun") return false;
  const minuteOfDay = hour * 60 + minute;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
}

interface Props {
  initialData: KeyDataPoint[];
}

export default function MacroSnapshotWidget({ initialData }: Props) {
  const [data, setData] = useState<KeyDataPoint[]>(initialData);
  const [live, setLive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const poll = async () => {
      if (!isMarketHours()) {
        setLive(false);
        return;
      }
      setLive(true);
      try {
        const res = await fetch("/api/briefing-macro");
        if (res.ok) {
          const fresh: KeyDataPoint[] = await res.json();
          if (Array.isArray(fresh) && fresh.length > 0) setData(fresh);
        }
      } catch {
        // Non-fatal — keep existing data on error
      }
    };

    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <>
      <div className="flex items-center gap-3 mb-5">
        <span className="inline-block text-[10px] font-bold tracking-widest uppercase text-navy-600 bg-slate-100 px-2.5 py-1 rounded">
          Macro Snapshot
        </span>
        {live && (
          <span className="flex items-center gap-1.5 text-[9px] font-bold tracking-widest uppercase text-accent-600">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse" />
            Live
          </span>
        )}
        <div className="flex-1 h-px bg-border" />
      </div>

      <div className="bg-navy-900 rounded-xl overflow-hidden">
        <div className="divide-y divide-white/10">
          {data.map((dp, i) => (
            <div key={i} className="px-5 py-3.5">
              <p className="text-white/40 text-[9px] font-semibold tracking-widest uppercase mb-1.5">
                {dp.label}
              </p>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-white font-bold text-[17px] tabular-nums tracking-tight">
                  {dp.value}
                </span>
                {dp.change && (
                  <span
                    className={`text-[11px] font-semibold tabular-nums whitespace-nowrap ${
                      dp.change.startsWith("-") ? "text-red-400" : "text-accent-400"
                    }`}
                  >
                    {dp.change.startsWith("-") ? "▼ " : "▲ "}
                    {dp.change.replace(/^[+-]/, "")}
                  </span>
                )}
              </div>
              {dp.source && (
                <p className="text-white/25 text-[9px] mt-1 tracking-wide">{dp.source}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
