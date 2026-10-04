"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Circle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { machineSelftest, type SelfTestEvent } from "@/lib/tauri";
import { getVmProvider, setLastTest } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/format";

export type SelfTestResult = "idle" | "running" | "ok" | "fail";

/** The steps each test reports, so the list shows up front instead of growing as it runs. */
const PLAN: Record<"docker" | "vm", { step: string; label: string }[]> = {
  docker: [
    { step: "engine", label: "Container engine answers" },
    { step: "pull", label: "Download a test image" },
    { step: "start", label: "Start a two-container test lab" },
    { step: "network", label: "Containers reach each other" },
    { step: "port", label: "Lab port reachable from this machine" },
    { step: "cleanup", label: "Clean up" },
  ],
  vm: [
    { step: "vagrant", label: "Vagrant is installed" },
    { step: "provider", label: "A hypervisor is ready" },
    { step: "hypervisor", label: "Hypervisor responds" },
    { step: "box", label: "Get a small test VM image" },
    { step: "boot", label: "Boot the test VM" },
    { step: "exec", label: "Run a command inside the VM" },
    { step: "network", label: "VM reachable on a lab network" },
    { step: "cleanup", label: "Delete the test VM" },
  ],
};

/** A runnable setup self-test with a live checklist. Runs once on mount when `auto`. */
export function SelfTest({
  kind,
  title,
  description,
  auto,
  onResult,
}: {
  kind: "docker" | "vm";
  title: string;
  description: string;
  auto?: boolean;
  onResult?: (r: SelfTestResult) => void;
}) {
  const [events, setEvents] = useState<Record<string, SelfTestEvent>>({});
  const [result, setResult] = useState<SelfTestResult>("idle");
  const started = useRef(false);
  // When the run and each step started and ended, for the counters (ms since epoch).
  const [run, setRun] = useState<{ start: number; end?: number } | null>(null);
  const [times, setTimes] = useState<Record<string, { start: number; end?: number }>>({});
  // Re-render once a second while running, so the counters tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (result !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [result]);

  const report = useCallback(
    (r: SelfTestResult) => {
      setResult(r);
      onResult?.(r);
    },
    [onResult],
  );

  const runTest = useCallback(async () => {
    setEvents({});
    setTimes({});
    setRun({ start: Date.now() });
    setNow(Date.now());
    report("running");
    const onEvent = (e: SelfTestEvent) => {
      setEvents((prev) => ({ ...prev, [e.step]: e }));
      const at = Date.now();
      setTimes((prev) => {
        const t = prev[e.step] ?? { start: at };
        return { ...prev, [e.step]: e.state === "running" ? t : { ...t, end: t.end ?? at } };
      });
    };
    try {
      await machineSelftest(kind, kind === "vm" ? getVmProvider() : null, onEvent);
      setLastTest(kind, "ok");
      report("ok");
    } catch {
      setLastTest(kind, "fail");
      report("fail");
    } finally {
      setRun((r) => (r ? { ...r, end: Date.now() } : r));
    }
  }, [kind, report]);

  useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      void runTest();
    }
  }, [auto, runTest]);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-3 border-b border-border px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{title}</p>
          <p className="text-[12px] text-muted-foreground">{description}</p>
        </div>
        <span className="ml-auto shrink-0">
          {result === "running" ? (
            <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Spinner className="size-3.5" /> Testing… <span className="font-mono tabular-nums">{run ? formatElapsed(now - run.start) : ""}</span>
            </span>
          ) : result === "ok" ? (
            <span className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-[12px] text-emerald-500">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Passed
                {run?.end ? <span className="font-mono tabular-nums text-muted-foreground">· {formatElapsed(run.end - run.start)}</span> : null}
              </span>
              <Button variant="ghost" size="sm" onClick={runTest} aria-label="Run again">
                <RefreshCw className="size-3.5" />
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              {result === "fail" && run?.end && (
                <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{formatElapsed(run.end - run.start)}</span>
              )}
              <Button variant={result === "fail" ? "outline" : "learn"} size="sm" onClick={runTest}>
                {result === "fail" ? (
                  <>
                    <RefreshCw className="size-3.5" /> Retry
                  </>
                ) : (
                  "Run test"
                )}
              </Button>
            </span>
          )}
        </span>
      </div>
      {result !== "idle" && (
        <ul className="space-y-1.5 px-3.5 py-3">
          {PLAN[kind].map(({ step, label }) => {
            const e: SelfTestEvent | undefined = events[step];
            const state: SelfTestEvent["state"] | "pending" = e ? e.state : "pending";
            return (
              <li key={step} className="flex items-start gap-2.5 text-[12.5px]">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  {state === "running" ? (
                    <Spinner className="size-3.5" />
                  ) : state === "ok" ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : state === "fail" ? (
                    <X className="size-3.5 text-rose-500" />
                  ) : (
                    <Circle className="size-2 text-muted-foreground/40" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn(state === "pending" || state === "skip" ? "text-muted-foreground" : "text-foreground")}>{label}</span>
                  {e?.detail && (
                    <span className={cn("block break-words font-mono text-[11px]", state === "fail" ? "text-rose-400" : "text-muted-foreground")}>
                      {e.detail}
                    </span>
                  )}
                </span>
                {times[step] && state !== "skip" && (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {formatElapsed((times[step].end ?? (result === "running" ? now : (run?.end ?? now))) - times[step].start)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
