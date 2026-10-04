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

// ---------- Small parts ----------

export function Log({ setup }: { setup: MachineSetupState }) {
  const { logs } = setup;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [logs]);
  if (logs.length === 0) return null;
  return (
    <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-[#070707] p-3 text-left font-mono text-[0.71875rem] leading-relaxed text-muted-foreground">
      {logs.join("\n")}
      <div ref={end} />
    </pre>
  );
}

export function CmdRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-[#070707] px-3 py-2">
      <code className="flex-1 overflow-x-auto text-left font-mono text-[0.75rem] text-foreground">{cmd}</code>
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
        className="inline-flex shrink-0 items-center gap-1 text-[0.71875rem] text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Num({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-left">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[0.6875rem] font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 text-[0.78125rem] leading-relaxed text-foreground">{children}</div>
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
        <p className="text-[0.8125rem] font-medium">{title}</p>
        <p className="text-[0.75rem] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function Skipped({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-left">
      <p className="text-[0.8125rem] font-medium text-muted-foreground">{title}</p>
      <p className="text-[0.75rem] text-muted-foreground">{reason}</p>
    </div>
  );
}
