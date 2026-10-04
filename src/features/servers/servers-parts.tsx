"use client";

import { type ReactNode } from "react";
import { Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "fail" | "muted";

// ---------- small parts ----------

/** Dot + label, in the machine-page style, so status reads the same across the app. */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = { ok: "text-emerald-500", warn: "text-amber-500", fail: "text-rose-500", muted: "text-muted-foreground" }[tone];
  const dot = { ok: "bg-emerald-500", warn: "bg-amber-500", fail: "bg-rose-500", muted: "bg-muted-foreground/50" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", c)}>
      <span className={cn("size-1.5 rounded-full", dot)} />
      {children}
    </span>
  );
}

export function TypeIcon({ children }: { children: ReactNode }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground">{children}</span>;
}

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border bg-surface text-muted-foreground">
        <Server className="size-5" />
      </span>
      <p className="mt-4 text-[14px] font-medium">No server connected</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-muted-foreground">
        Add your Proxmox or ESXi server to run heavier, multi-VM labs on it instead of this machine.
      </p>
      <Button variant="learn" size="sm" className="mt-5" onClick={onAdd}>
        <Plus className="size-3.5" /> Add host
      </Button>
    </div>
  );
}
