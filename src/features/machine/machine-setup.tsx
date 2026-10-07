"use client";

import { ErrorBoundary } from "@/components/error-screen";

import { useState } from "react";
import { ArrowLeft, Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MachineStepBody, SetupOutcome, canContinue, machineSteps, nextLabel, stepMeta, useMachineSetup } from "@/features/machine/setup-steps";
import type { SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The guided "set up this machine" window. The steps themselves are shared with the
 *  onboarding (`setup-steps`); this file is only the window's frame. */
export function MachineSetup({
  report,
  onRefresh,
  onClose,
  startAt,
}: {
  report: SystemReport | null;
  onRefresh: () => void;
  onClose: () => void;
  /** Open at this step (a "Fix" link from the Machine page); changes jump again. */
  startAt?: { step: string; nonce: number } | null;
}) {
  const steps = [...machineSteps(report), "ready" as const];
  const [i, setI] = useState(0);
  // Jump to the requested step once the report is in (the step list depends on it).
  const [jumped, setJumped] = useState<number | null>(null);
  if (startAt && report && startAt.nonce !== jumped) {
    setJumped(startAt.nonce);
    const n = (steps as string[]).indexOf(startAt.step);
    if (n >= 0) setI(n);
  }
  const at = Math.min(i, steps.length - 1);
  const key = steps[at];
  const setup = useMachineSetup(report, onRefresh);
  const next = () => setI(Math.min(at + 1, steps.length - 1));
  const back = () => setI(Math.max(at - 1, 0));

  const osName = report?.os === "windows" ? "Windows" : report?.os === "macos" ? "macOS" : "Linux";
  const meta =
    key === "ready"
      ? { icon: Sparkles, title: "You’re set up", description: "You can run this guide again anytime from the Machine page." }
      : stepMeta(key, report);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Overlay title bar: drags the window and clears the macOS traffic lights. */}
      <div data-tauri-drag-region className="h-11 shrink-0 select-none" />

      {/* Until the machine check answers, just say so: the title, stepper and step count all
          depend on what it finds. */}
      {!report ? (
        <div className="flex flex-1 items-center justify-center gap-2 pb-11 text-[0.8125rem] text-muted-foreground">
          <Spinner className="size-4" /> Checking this machine…
        </div>
      ) : (
        /* Scrolls when a step is long; centered in the window when it's short. */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-6 pt-2 pb-10">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Set up this machine</h1>
              <p className="mt-1 text-[0.8125rem] text-muted-foreground">Get {osName} ready to run labs, one step at a time.</p>
            </div>

            <div className="mt-5 flex gap-1.5">
              {steps.map((_, n) => (
                <div key={n} className={cn("h-1 flex-1 rounded-full transition-colors", n <= at ? "bg-learn" : "bg-muted")} />
              ))}
            </div>

            <div key={key} className="mt-7 animate-rise-in">
              <>
                <p className="text-[0.71875rem] font-medium tabular-nums text-muted-foreground">
                  Step {at + 1} of {steps.length}
                </p>
                <div className="mt-2 flex items-start gap-3.5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
                    <meta.icon className="size-5 text-foreground" />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <h2 className="text-lg font-semibold tracking-tight">{meta.title}</h2>
                    <p className="mt-1 text-[0.78125rem] leading-relaxed text-muted-foreground">{meta.description}</p>
                  </div>
                </div>
                <div className="mt-6">
                  <ErrorBoundary resetKey={key} title="This step couldn’t load">
                    {key === "ready" ? <SetupOutcome report={report} setup={setup} /> : <MachineStepBody step={key} report={report} setup={setup} />}
                  </ErrorBoundary>
                </div>
                <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
                  <div>
                    {at > 0 && (
                      <Button variant="outline" onClick={back} disabled={setup.busy}>
                        <ArrowLeft className="size-4" /> Back
                      </Button>
                    )}
                  </div>
                  {key === "ready" ? (
                    <Button variant="learn" onClick={onClose}>
                      <Play className="size-4" /> Done
                    </Button>
                  ) : (
                    <Button variant="learn" onClick={next} disabled={setup.busy || !canContinue(key, report, setup)}>
                      {nextLabel(key, report)}
                    </Button>
                  )}
                </div>
              </>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
