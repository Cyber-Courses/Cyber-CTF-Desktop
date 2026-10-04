"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { MachineSetupState } from "@/features/machine/setup-steps/use-machine-setup";

export function Requirement({
  ok,
  title,
  detail,
  action,
  optional,
}: {
  ok: boolean;
  title: string;
  detail: string;
  action: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {ok ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <span className={cn("size-1.5 rounded-full", optional ? "bg-muted-foreground/40" : "bg-amber-500")} />
        )}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[0.8125rem] text-foreground">{title}</span>
        <span className="block break-words font-mono text-[0.6875rem] text-muted-foreground">{detail}</span>
      </span>
      {!ok && <span className="shrink-0">{action}</span>}
    </div>
  );
}

// ---------- Choices (pick one of several equivalent options) ----------

export function ChoiceGrid({ children }: { children: React.ReactNode }) {
  return (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
      {children}
    </div>
  );
}

/** One option: selecting it shows its install / status below, the others stay alternatives. */
export function Choice({
  selected,
  onSelect,
  mark,
  title,
  note,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  mark: React.ReactNode;
  title: string;
  note: string;
  badge?: "in use" | "running" | "installed" | "recommended";
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-foreground/40 bg-foreground/[0.04]" : "border-border hover:border-foreground/20",
      )}
    >
      {mark}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[0.8125rem] font-medium text-foreground">
          {title}
          {badge && (
            <span
              className={cn(
                "rounded px-1.5 py-px text-[0.65625rem] font-normal",
                badge === "recommended"
                  ? "border border-border text-muted-foreground"
                  : badge === "running"
                    ? "border border-emerald-500/30 text-emerald-500"
                    : "bg-emerald-500/10 text-emerald-500",
              )}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[0.75rem] text-muted-foreground">{note}</span>
      </span>
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-foreground" : "border-border")}>
        {selected && <span className="size-2 rounded-full bg-foreground" />}
      </span>
    </button>
  );
}

/** What to do for the selected option: install it, get it, or nothing (it's ready). */
export function ChoiceAction({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left">{children}</div>;
}

// ---------- Small parts ----------

export function Log({ setup }: { setup: MachineSetupState }) {
  const { logs } = setup;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [logs]);
  if (logs.length === 0) return null;
  return (
    <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-[#070707] p-3 text-left font-mono text-[11.5px] leading-relaxed text-muted-foreground">
      {logs.join("\n")}
      <div ref={end} />
    </pre>
  );
}

export function CmdRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-[#070707] px-3 py-2">
      <code className="flex-1 overflow-x-auto text-left font-mono text-[12px] text-foreground">{cmd}</code>
      <button
        onClick={() =>
          navigator.clipboard
            ?.writeText(cmd)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => {})
        }
        className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Num({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-left">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 text-[12.5px] leading-relaxed text-foreground">{children}</div>
    </li>
  );
}

export function Outcome({ title, ok, detail }: { title: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3.5 py-3 text-left last:border-b-0">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground",
        )}
      >
        <CheckCircle2 className="size-4" />
      </span>
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-[12px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function Skipped({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-left">
      <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
      <p className="text-[12px] text-muted-foreground">{reason}</p>
    </div>
  );
}
