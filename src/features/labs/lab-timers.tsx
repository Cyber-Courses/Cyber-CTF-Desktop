"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";
import { useFormat, useT, type T } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Time since Start was pressed, ticking. */
export function StartTimer() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tabular-nums opacity-80">{formatDuration(now - start)}</span>;
}

/** "3h 58m", "58m": a time left, in hours and minutes. */
export function hoursMinutes(t: T, h: number, m: number): string {
  return h > 0 ? t("labs.duration.hm", { h, m }) : t("labs.duration.m", { m });
}

/** "Auto-stops at 19:42 · in 3h 58m" for cloud labs, as inline mono text in the warning colour. */
export function AutoStop({ at, className }: { at: number; className?: string }) {
  const t = useT();
  const format = useFormat();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, at - now);
  const time = format.date(at * 1000, { hour: "2-digit", minute: "2-digit" });
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return (
    <span className={cn("font-mono text-[0.6875rem] tabular-nums text-warning", className)}>
      {t("labs.timers.autoStop", { time, left: hoursMinutes(t, h, m) })}
    </span>
  );
}
