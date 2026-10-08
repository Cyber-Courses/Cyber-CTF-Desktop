"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import { PanelHeader } from "@/components/ui/panel";
import { StatusDot, StatusPill } from "@/components/ui/status-pill";
import { LogConsole } from "@/components/ui/log-console";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import type { ActiveOperation } from "@/lib/tauri";

type Operation = ActiveOperation["op"];

// Operations on a lab that is already built: one step named after them, not the launch's
// "Building" / "Preparing", which read as a new deploy while the lab was shutting down.
const OPERATIONS: Partial<Record<Operation, { busy: string; step: string; done: string }>> = {
  resume: { busy: "Resuming", step: "Bring the machines back", done: "Resumed" },
  pause: { busy: "Pausing", step: "Save the machines' state", done: "Paused" },
  shutdown: { busy: "Shutting down", step: "Power the machines off", done: "Shut down" },
  stop: { busy: "Stopping", step: "Remove the machines", done: "Removed" },
  attack_vm: { busy: "Starting", step: "Start the attack VM", done: "Started" },
};

/**
 * A lab's start-up as named steps with their durations, Vercel-build style. The steps are read
 * from the launch log as it streams and timed when each line arrives. Which steps appear depends
 * on the target the launcher is driving, detected from the output itself:
 *  - Docker Compose: pull images, create, start, wait until healthy.
 *  - Vagrant (a VM on this machine, or an ESXi host): one step per machine (dc01, ws01, …), each
 *    showing its live action (importing the box, booting, provisioning).
 *  - Terraform (a cloud account or Proxmox): set up Terraform, create the infrastructure, then
 *    install and start the lab on the host.
 * The raw log stays one click away.
 */

type Timed = { line: string; at: number };
type Step = { id: string; label: string; rows: Timed[] };

// Docker Compose phases, matched line by line.
type Phase = { id: string; label: string; match: (line: string) => boolean };
const DOCKER_PHASES: Phase[] = [
  { id: "images", label: "Get images", match: (l) => /\bImage\b.*\b(Pulling|Pulled|Building|Built)\b|^\s*(Pulling|Building)\b/.test(l) },
  { id: "create", label: "Create the network and containers", match: (l) => /\b(Network|Volume|Container)\b.*\b(Creating|Created)\b/.test(l) },
  { id: "start", label: "Start the containers", match: (l) => /\bContainer\b.*\b(Starting|Started)\b/.test(l) },
  { id: "health", label: "Wait until healthy", match: (l) => /\bContainer\b.*\b(Waiting|Healthy|Exited)\b/.test(l) },
];

/** Which target's output this is, inferred from the lines seen so far. */
function detectTarget(text: string): "vagrant" | "terraform" | "docker" | "unknown" {
  if (/^\s*==>\s*\S+:/m.test(text) || /Bringing machine '.*' up/.test(text)) return "vagrant";
  if (/Initializing the backend|Terraform (has been|will perform)|^\s*[\w.[\]"-]+: (Creating|Creation complete|Still creating)/m.test(text)) return "terraform";
  if (/\bContainer\b.*\b(Creating|Started|Running)\b|^\s*Pulling\s|\bNetwork\b.*\bCreat/m.test(text)) return "docker";
  return "unknown";
}

// A line the launcher prints while fetching/placing the lab, before the target's own output.
const isDownloadLine = (l: string) => /^(Downloading|Cloning|Lab installed|Fetching)\b|^Running (on server host|in a .* VM)/.test(l);
// The launcher's own narration during a local VM start (recovery, provider choice).
const isPrepLine = (l: string) => /left VM state behind|Clearing leftover|different target|Recovering|Preparing the lab/.test(l);

const machineLabel = (name: string) => name.replace(/^isoloom-/, "");

/** The step of the machine a Vagrant failure names ("…while executing the action on the
 *  'isoloom-controller' machine"), if it names one: that step failed, not necessarily the last
 *  one shown (another machine's lines can come last, as in a parallel `vagrant up`). */
export function failedMachineStep(failure: string): string | null {
  const m = failure.match(/executing the action on the '([A-Za-z0-9_.-]+)'/);
  return m ? `m:${m[1]}` : null;
}

/** Builds the ordered step list from the timed log, per the detected target. */
function deriveSteps(timed: Timed[]): Step[] {
  const steps: Step[] = [];
  const push = (id: string, label: string, t: Timed) => {
    let s = steps.find((x) => x.id === id);
    if (!s) {
      s = { id, label, rows: [] };
      steps.push(s);
    }
    s.rows.push(t);
  };
  const target = detectTarget(timed.map((t) => t.line).join("\n"));
  let machine: string | null = null;
  let docker: Phase | null = null;
  for (const t of timed) {
    const l = t.line;
    if (isDownloadLine(l)) {
      push("download", "Download the lab", t);
      continue;
    }
    if (target === "vagrant") {
      const m = l.match(/^\s*==>\s*([A-Za-z0-9_.-]+):/);
      if (m) machine = m[1];
      if (machine) push(`m:${machine}`, machineLabel(machine), t);
      else push("prepare", isPrepLine(l) ? "Prepare this machine" : "Start", t);
    } else if (target === "terraform") {
      if (/Initializing|terraform init|Installing|Finding .* versions|Reusing previous/.test(l)) push("tf-init", "Set up Terraform", t);
      else if (/Creating\.\.\.|Creation complete|Still creating|Destroying|Apply complete|Plan:|will perform|Modif/.test(l))
        push("tf-apply", "Create the infrastructure", t);
      else if (/Waiting for the lab host|running:|install Docker|cloud-init|bootstrap|is ready|ready/i.test(l))
        push("tf-ready", "Install and start the lab", t);
      else push(steps.at(-1)?.id ?? "tf-init", steps.at(-1)?.label ?? "Set up Terraform", t);
    } else if (target === "docker") {
      const p = DOCKER_PHASES.find((ph) => ph.match(l));
      if (p) docker = p;
      if (docker) push(docker.id, docker.label, t);
      else push("prepare", "Prepare the lab", t);
    } else {
      push(steps.at(-1)?.id ?? "prepare", steps.at(-1)?.label ?? "Preparing", t);
    }
  }
  return steps;
}

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

export function DeploySteps({
  lines,
  times,
  busy,
  ready,
  where,
  operation = "launch",
}: {
  lines: string[];
  times?: number[];
  busy: boolean;
  ready: boolean;
  where?: string;
  /** What the log is of: a launch (steps read from the output) or an operation on the built lab. */
  operation?: Operation;
}) {
  const fallback = useTimedLines(lines);
  // Prefer the per-line timestamps kept in the deploy store (they survive leaving and returning
  // to the page, so the step durations don't reset); fall back to local timing if absent.
  const timed: Timed[] = times && times.length === lines.length ? lines.map((line, i) => ({ line, at: times[i] })) : fallback;
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

  // The steps to show, built from the log per the detected target (Vagrant / Terraform / Docker).
  const op = OPERATIONS[operation];
  const steps = op ? (timed.length > 0 ? [{ id: operation, label: op.step, rows: timed }] : []) : deriveSteps(timed);
  const lastSeen = steps.at(-1)?.id;
  const named = failed ? failedMachineStep(failed.line) : null;
  const failedStep = failed ? (named && steps.some((s) => s.id === named) ? named : lastSeen) : null;

  return (
    <div>
      <PanelHeader
        title={
          <>
            Deployment
            {where && (
              <span className="truncate font-normal text-muted-foreground">
                on <span className="text-foreground">{where}</span>
              </span>
            )}
          </>
        }
        action={
          <span className="flex items-center gap-2.5">
            {failed ? (
              <StatusPill tone="fail">Failed</StatusPill>
            ) : busy ? (
              <StatusPill tone="warn" pulse>
                {op?.busy ?? "Building"}
              </StatusPill>
            ) : ready || (done && !op) ? (
              <StatusPill tone="ok">Ready</StatusPill>
            ) : op && timed.length > 0 ? (
              <StatusPill tone="muted">{op.done}</StatusPill>
            ) : null}
            {start && end && <span className="font-mono text-[0.6875rem] tabular-nums text-faint">{formatDuration(end - start)}</span>}
          </span>
        }
      />

      <ul className="py-1 empty:hidden">
        {steps.map((p, i) => {
          const rows = p.rows;
          const next = steps[i + 1]?.rows[0]?.at;
          const isLast = p.id === lastSeen;
          const state = p.id === failedStep ? "fail" : isLast && busy ? "running" : "ok";
          const from = rows[0].at;
          const to = next ?? (state === "running" ? now : (done?.at ?? failed?.at ?? rows.at(-1)!.at));
          const expanded = open === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : p.id)}
                className="group grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto_0.875rem] items-center gap-3 px-4 py-2 text-left text-[0.8125rem] transition-colors hover:bg-glass"
              >
                <StepMark state={state} />
                <span className={cn("truncate", state === "fail" ? "text-destructive" : "text-foreground")}>{p.label}</span>
                <span className="font-mono text-[0.6875rem] tabular-nums text-faint">{formatDuration(to - from)}</span>
                <ChevronRight className={cn("size-3.5 text-faint transition-transform group-hover:text-muted-foreground", expanded && "rotate-90")} />
              </button>
              {/* While a phase is running, show its latest line inline (e.g. which container is
                  still "Waiting"), so the long "Wait until healthy" step isn't a blank spinner. */}
              {state === "running" && !expanded && rows.at(-1)?.line && (
                <div className="-mt-1 truncate px-4 pb-2 pl-12 font-mono text-[0.6875rem] text-faint">{rows.at(-1)!.line.trim()}</div>
              )}
              {expanded && (
                <div className="px-4 pb-2.5 pl-12">
                  <TimedLog rows={rows} origin={start!} />
                </div>
              )}
            </li>
          );
        })}
        {done && !op && (
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 px-4 py-2 text-[0.8125rem]">
            <StepMark state="ok" />
            <span className="text-foreground">Ready</span>
          </li>
        )}
        {busy && steps.length === 0 && (
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 px-4 py-2 text-[0.8125rem] text-muted-foreground">
            <StepMark state="pending" />
            {op ? `${op.busy}…` : "Preparing…"}
          </li>
        )}
      </ul>

      {failed && (
        <p className="flex items-start gap-2 border-t border-border px-4 py-2.5 font-mono text-[0.6875rem] text-muted-foreground">
          <StatusDot tone="fail" className="mt-1 shrink-0" />
          <span className="min-w-0 break-words">{failed.line.replace(/^✗\s*/, "")}</span>
        </p>
      )}

      {timed.length > 0 && (
        <div className="border-t border-border px-4 py-2">
          <button
            type="button"
            aria-expanded={showLog}
            onClick={() => setShowLog((v) => !v)}
            className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", showLog && "rotate-90")} /> {showLog ? "Hide" : "Show"} full log
          </button>
          {showLog && (
            <div className="mt-2 pb-1">
              <LogConsole lines={timed.map((t) => `${formatDuration(t.at - start!).padStart(6)}  ${t.line}`)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A step's 1.1rem circle: done (filled success with a check), running (warning ring with a
 *  pulsing dot), failed (fail ring with a cross), pending (an input ring). */
function StepMark({ state }: { state: "ok" | "running" | "fail" | "pending" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[1.1rem] items-center justify-center rounded-full",
        state === "ok" && "bg-success text-background",
        state === "running" && "shadow-[inset_0_0_0_0.09375rem_var(--warning)]",
        state === "fail" && "text-destructive shadow-[inset_0_0_0_0.09375rem_var(--destructive)]",
        state === "pending" && "shadow-[inset_0_0_0_0.09375rem_var(--input)]",
      )}
    >
      {state === "ok" && <Check className="size-2.5" strokeWidth={3.5} />}
      {state === "running" && <span className="size-[0.4rem] animate-pulse rounded-full bg-warning" />}
      {state === "fail" && <X className="size-2.5" strokeWidth={3} />}
    </span>
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
    <div ref={box} className="surface-log max-h-48 overflow-auto rounded-sm px-3 py-2 font-mono text-[0.6875rem] leading-relaxed">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-3">
          <span className="w-12 shrink-0 text-right tabular-nums text-faint">{formatDuration(r.at - origin)}</span>
          <span className="min-w-0 break-words text-muted-foreground">{r.line}</span>
        </div>
      ))}
    </div>
  );
}
