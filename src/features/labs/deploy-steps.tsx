"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Circle, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";

/**
 * A lab's start-up as named steps with their durations, Vercel-build style. The steps are
 * read from the launch log as it streams (the launcher's own lines and Docker Compose's
 * progress), and each line is timed when it arrives. The raw log stays one click away.
 */

type Phase = { id: string; label: string; match: (line: string) => boolean };

const PHASES: Phase[] = [
  { id: "download", label: "Download the lab", match: (l) => /^Downloading |^Lab installed|^Running on server host/.test(l) },
  { id: "images", label: "Get images", match: (l) => /\bImage\b.*\b(Pulling|Pulled|Building|Built)\b|^\s*(Pulling|Building)\b/.test(l) },
  { id: "create", label: "Create the network and containers", match: (l) => /\b(Network|Volume|Container)\b.*\b(Creating|Created)\b/.test(l) },
  { id: "start", label: "Start the containers", match: (l) => /\bContainer\b.*\b(Starting|Started)\b/.test(l) },
  { id: "health", label: "Wait until healthy", match: (l) => /\bContainer\b.*\b(Waiting|Healthy|Exited)\b/.test(l) },
];

type Timed = { line: string; at: number };

/** Times each log line when it arrives; starts over when a new launch clears the log. */
function useTimedLines(lines: string[]): Timed[] {
  const [timed, setTimed] = useState<Timed[]>([]);
  useEffect(() => {
    const at = Date.now();
    // Records when lines arrived, a fact only known as they stream in.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTimed((prev) => {
      const base = lines.length < prev.length || (prev.length > 0 && prev[0].line !== lines[0]) ? [] : prev;
      return base.length === lines.length ? base : [...base, ...lines.slice(base.length).map((line) => ({ line, at }))];
    });
  }, [lines]);
  return timed;
}

export function DeploySteps({ lines, busy, ready }: { lines: string[]; busy: boolean; ready: boolean }) {
  const timed = useTimedLines(lines);
  const [open, setOpen] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [busy]);

  const failed = timed.find((t) => t.line.startsWith("✗"));
  const done = timed.find((t) => t.line.startsWith("✓"));
  const start = timed[0]?.at;
  const end = done?.at ?? failed?.at ?? (busy ? now : timed.at(-1)?.at);

  // Assign each line to the phase it matches; unmatched lines stay with the current phase.
  const byPhase = new Map<string, Timed[]>();
  let current: string | null = null;
  for (const t of timed) {
    const p = PHASES.find((ph) => ph.match(t.line));
    if (p) current = p.id;
    if (current) byPhase.set(current, [...(byPhase.get(current) ?? []), t]);
  }
  const seen = PHASES.filter((p) => byPhase.has(p.id));
  const lastSeen = seen.at(-1)?.id;

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <h3 className="text-[0.8125rem] font-medium">Deployment</h3>
        <span className="ml-auto flex items-center gap-2 text-[0.75rem]">
          {failed ? (
            <span className="flex items-center gap-1.5 text-rose-400">
              <X className="size-3.5" /> Failed
            </span>
          ) : busy ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Spinner className="size-3.5" /> Building
            </span>
          ) : ready || done ? (
            <span className="flex items-center gap-1.5 text-emerald-500">
              <span className="size-1.5 rounded-full bg-emerald-500" /> Ready
            </span>
          ) : null}
          {start && end && <span className="font-mono tabular-nums text-muted-foreground">{formatDuration(end - start)}</span>}
        </span>
      </div>

      <ul className="divide-y divide-border">
        {seen.map((p, i) => {
          const rows = byPhase.get(p.id)!;
          const next = seen[i + 1] ? byPhase.get(seen[i + 1].id)![0].at : undefined;
          const isLast = p.id === lastSeen;
          const state = failed && isLast ? "fail" : isLast && busy ? "running" : "ok";
          const from = rows[0].at;
          const to = next ?? (state === "running" ? now : (done?.at ?? failed?.at ?? rows.at(-1)!.at));
          const expanded = open === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : p.id)}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.78125rem] transition-colors hover:bg-foreground/[0.03]"
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {state === "running" ? (
                    <Spinner className="size-3.5" />
                  ) : state === "fail" ? (
                    <X className="size-3.5 text-rose-400" />
                  ) : (
                    <Check className="size-3.5 text-emerald-500" />
                  )}
                </span>
                <span className={cn("flex-1", state === "fail" ? "text-rose-300" : "text-foreground")}>{p.label}</span>
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground">{formatDuration(to - from)}</span>
                <ChevronRight className={cn("size-3.5 text-muted-foreground/60 transition-transform", expanded && "rotate-90")} />
              </button>
              {expanded && (
                <div className="px-3.5 pb-2.5">
                  <TimedLog rows={rows} origin={start!} />
                </div>
              )}
            </li>
          );
        })}
        {done && (
          <li className="flex items-center gap-2.5 px-3.5 py-2 text-[0.78125rem]">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Check className="size-3.5 text-emerald-500" />
            </span>
            <span className="flex-1 text-foreground">Ready</span>
          </li>
        )}
        {busy && seen.length === 0 && (
          <li className="flex items-center gap-2.5 px-3.5 py-2 text-[0.78125rem] text-muted-foreground">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Circle className="size-2" />
            </span>
            Preparing…
          </li>
        )}
      </ul>

      {failed && <p className="border-t border-border px-3.5 py-2.5 font-mono text-[0.6875rem] text-rose-400">{failed.line.replace(/^✗\s*/, "")}</p>}

      {timed.length > 0 && (
        <div className="border-t border-border px-3.5 py-2">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="flex items-center gap-1.5 text-[0.71875rem] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", showLog && "rotate-90")} /> {showLog ? "Hide" : "Show"} full log
          </button>
          {showLog && (
            <div className="mt-2">
              <LogConsole lines={timed.map((t) => `${formatDuration(t.at - start!).padStart(6)}  ${t.line}`)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A phase's own lines, each with its time since the launch started. */
function TimedLog({ rows, origin }: { rows: Timed[]; origin: number }) {
  const box = useRef<HTMLDivElement>(null);
  // Tail the log: keep the newest line in view as the deployment streams.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);
  return (
    <div ref={box} className="max-h-48 overflow-auto rounded-md border border-border bg-[#070707] p-2 font-mono text-[0.6875rem] leading-relaxed">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-3">
          <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground/60">{formatDuration(r.at - origin)}</span>
          <span className="min-w-0 break-words text-muted-foreground">{r.line}</span>
        </div>
      ))}
    </div>
  );
}
