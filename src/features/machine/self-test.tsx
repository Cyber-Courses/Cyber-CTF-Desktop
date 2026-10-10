"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-pill";
import { StepRow } from "@/features/machine/step-row";
import { machineSelftest, type SelfTestEvent } from "@/lib/tauri";
import { getVmProvider, setLastTest } from "@/lib/settings";
import { formatElapsed } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { useT, type MessageKey } from "@/lib/i18n";

export type SelfTestResult = "idle" | "running" | "ok" | "fail";

/** The steps each test reports, so the list shows up front instead of growing as it runs. */
const PLAN: Record<"docker" | "vm", { step: string; label: MessageKey }[]> = {
  docker: [
    { step: "engine", label: "machine.selfTest.docker.engine" },
    { step: "pull", label: "machine.selfTest.docker.pull" },
    { step: "start", label: "machine.selfTest.docker.start" },
    { step: "network", label: "machine.selfTest.docker.network" },
    { step: "port", label: "machine.selfTest.docker.port" },
    { step: "cleanup", label: "machine.selfTest.docker.cleanup" },
  ],
  vm: [
    { step: "vagrant", label: "machine.selfTest.vm.vagrant" },
    { step: "provider", label: "machine.selfTest.vm.provider" },
    { step: "hypervisor", label: "machine.selfTest.vm.hypervisor" },
    { step: "box", label: "machine.selfTest.vm.box" },
    { step: "boot", label: "machine.selfTest.vm.boot" },
    { step: "exec", label: "machine.selfTest.vm.exec" },
    { step: "network", label: "machine.selfTest.vm.network" },
    { step: "cleanup", label: "machine.selfTest.vm.cleanup" },
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
  const t = useT();
  const [events, setEvents] = useState<Record<string, SelfTestEvent>>({});
  const [result, setResult] = useState<SelfTestResult>("idle");
  const started = useRef(false);
  // When the run and each step started and ended, for the counters (ms since epoch).
  const [run, setRun] = useState<{ start: number; end?: number } | null>(null);
  const [times, setTimes] = useState<Record<string, { start: number; end?: number }>>({});
  // Re-render once a second while running, so the counters tick.
  const [now, touchNow] = useNow(1000, result === "running");

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
    touchNow();
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
  }, [kind, report, touchNow]);

  useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      void runTest();
    }
  }, [auto, runTest]);

  const passed = PLAN[kind].filter(({ step }) => events[step]?.state === "ok").length;
  return (
    <div className="overflow-hidden rounded-control bg-glass shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-medium text-foreground">{title}</p>
          <p className="text-[0.75rem] text-muted-foreground">{description}</p>
        </div>
        <span className="ml-auto shrink-0">
          {result === "running" ? (
            <span className="flex items-center gap-2 text-[0.75rem] text-muted-foreground">
              <StatusDot tone="warn" pulse /> {t("machine.selfTest.testing")}
              <span className="font-mono text-[0.6875rem] tabular-nums text-faint">
                {passed}/{PLAN[kind].length} · {run ? formatElapsed(now - run.start) : ""}
              </span>
            </span>
          ) : result === "ok" ? (
            <span className="flex items-center gap-2">
              <span className="flex items-center gap-2 text-[0.75rem] text-foreground">
                <StatusDot tone="ok" /> {t("machine.selfTest.passed")}
                {run?.end ? <span className="font-mono text-[0.6875rem] tabular-nums text-faint">{formatElapsed(run.end - run.start)}</span> : null}
              </span>
              <Button variant="ghost" size="icon-sm" onClick={runTest} aria-label={t("machine.selfTest.runAgain")}>
                <RefreshCw />
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              {result === "fail" && (
                <span className="flex items-center gap-2 text-[0.75rem] text-destructive">
                  <StatusDot tone="fail" /> {t("machine.selfTest.failed")}
                  {run?.end && <span className="font-mono text-[0.6875rem] tabular-nums text-faint">{formatElapsed(run.end - run.start)}</span>}
                </span>
              )}
              <Button variant={result === "fail" ? "outline" : "primary"} size="xs" onClick={runTest}>
                {result === "fail" ? (
                  <>
                    <RefreshCw /> {t("machine.selfTest.retry")}
                  </>
                ) : (
                  t("machine.selfTest.run")
                )}
              </Button>
            </span>
          )}
        </span>
      </div>
      {result !== "idle" && (
        <ul className="py-1.5">
          {PLAN[kind].map(({ step, label }) => {
            const e: SelfTestEvent | undefined = events[step];
            const state: SelfTestEvent["state"] | "pending" = e ? e.state : "pending";
            const time = times[step];
            return (
              <li key={step}>
                <StepRow
                  state={state === "ok" ? "done" : state === "running" ? "run" : state}
                  label={t(label)}
                  detail={e?.detail}
                  detailTone={state === "fail" ? "fail" : undefined}
                  meta={
                    time && state !== "skip"
                      ? formatElapsed((time.end ?? (result === "running" ? now : (run?.end ?? now))) - time.start)
                      : state === "skip"
                        ? t("machine.selfTest.skipped")
                        : undefined
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
