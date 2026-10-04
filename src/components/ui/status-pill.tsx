import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "fail" | "muted";

/** A coloured dot and label for a status (ready, needs attention, failed, idle). */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = { ok: "text-emerald-500", warn: "text-amber-500", fail: "text-rose-500", muted: "text-muted-foreground" }[tone];
  const dot = { ok: "bg-emerald-500", warn: "bg-amber-500", fail: "bg-rose-500", muted: "bg-muted-foreground/50" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[0.75rem] font-medium", c)}>
      <span className={cn("size-1.5 rounded-full", dot)} />
      {children}
    </span>
  );
}
