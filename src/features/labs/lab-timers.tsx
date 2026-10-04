"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

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

/** "Auto-stops at 19:42 · in 3h 58m" for cloud labs. */
export function AutoStop({ at }: { at: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, at - now);
  const time = new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return (
    <p className="text-[0.71875rem] text-amber-500">
      Auto-stops at {time} · in {h > 0 ? `${h}h ` : ""}
      {m}m
    </p>
  );
}
