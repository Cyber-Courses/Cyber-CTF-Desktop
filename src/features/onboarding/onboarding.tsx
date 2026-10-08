"use client";

import { ErrorBoundary } from "@/components/error-screen";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import {
  MachineStepBody,
  SetupOutcome,
  canContinue,
  machineSteps,
  nextLabel,
  stepMeta,
  useMachineSetup,
  type MachineStep,
} from "@/features/machine/setup-steps";
import { authLogin, authStatus, systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type OnboardingStep = "welcome" | "signin" | MachineStep | "done";

/** Names for the progress line. VM steps are optional: Docker labs run without them. */
const STEP_NAMES: Record<OnboardingStep, string> = {
  welcome: "Welcome",
  signin: "Sign in",
  pkgmgr: "Package manager",
  virtualization: "Virtualization",
  docker: "Container engine",
  "docker-test": "Container test",
  attack: "Attack box",
  vm: "Virtual machines (optional)",
  vagrant: "Vagrant (optional)",
  "vm-test": "VM test (optional)",
  done: "Done",
};

function StepHeader({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-panel border border-border bg-surface">{icon}</div>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Feature({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 rounded-control border border-border bg-card p-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
        <Icon name={icon} className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function SummaryRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-control border border-border bg-card p-3">
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-6 items-center justify-center rounded-full", ok ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
          <Icon name={ok ? "check" : "arrowRight"} className="size-3.5" />
        </span>
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <span className={cn("text-xs", ok ? "text-success" : "text-muted-foreground")}>{value}</span>
    </div>
  );
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [i, setI] = useState(0);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [report, setReport] = useState<SystemReport | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const refreshReport = () => {
    systemCheck()
      .then(setReport)
      .catch(() => setReport(null));
  };
  useEffect(() => {
    authStatus()
      .then(setAuth)
      .catch(() => setAuth(null));
    refreshReport();
    // Poll so an install finished in a native installer is picked up without a re-check.
    const id = setInterval(refreshReport, 5000);
    return () => clearInterval(id);
  }, []);

  // The machine steps are the same ones the "Set up this machine" window shows.
  const setup = useMachineSetup(report, refreshReport);
  const steps: OnboardingStep[] = ["welcome", "signin", ...machineSteps(report), "done"];
  const step = steps[Math.min(i, steps.length - 1)];
  const next = () => setI((n) => Math.min(n + 1, steps.length - 1));
  const back = () => setI((n) => Math.max(n - 1, 0));

  async function login() {
    setLoggingIn(true);
    setLoginError(null);
    try {
      setAuth(await authLogin());
    } catch (e) {
      // Stay on this step, and say why: a timeout, a missing browser or an unsaved session.
      setLoginError(String(e));
    } finally {
      setLoggingIn(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Draggable title bar (Overlay style has no native bar); room for traffic lights. */}
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-between pr-4 pl-20">
        <div className="pointer-events-none flex items-center gap-2">
          <Image src="/logo-mark.svg" alt="" width={18} height={18} className="size-[1.125rem]" priority />
          <span className="text-xs font-medium tracking-tight text-muted-foreground">Cyber CTF</span>
        </div>
        {step !== "done" && (
          <button onClick={onComplete} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            Skip setup
          </button>
        )}
      </div>

      {/* Progress segments, with the step's name and position */}
      <div className="mx-auto w-full max-w-lg px-6 pt-1">
        <div className="flex gap-1.5">
          {steps.map((_, n) => (
            <div key={n} className={cn("h-1 flex-1 rounded-full transition-colors", n <= i ? "bg-jewel-solid" : "bg-muted")} />
          ))}
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Step {Math.min(i, steps.length - 1) + 1} of {steps.length} · {STEP_NAMES[step]}
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div key={step} className="w-full max-w-lg animate-rise-in">
          {step === "welcome" && (
            <div>
              <div className="text-center">
                <div className="mx-auto flex size-16 items-center justify-center rounded-panel border border-border bg-surface">
                  <Image src="/logo-mark.svg" alt="" width={36} height={36} className="size-9" priority />
                </div>
                <h1 className="mt-6 text-2xl font-semibold tracking-tight">Welcome to Cyber CTF</h1>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                  Run realistic, isolated security labs on your machine, your own server or the cloud, launched from the app or straight from the website.
                </p>
              </div>
              <div className="mt-8 space-y-2.5">
                <Feature
                  icon="container"
                  title="Container & VM labs"
                  description="Docker containers and full virtual machines, each lab on its own isolated network."
                />
                <Feature
                  icon="cloud"
                  title="Run it where you want"
                  description="On this machine, your own server (Proxmox, ESXi) or your cloud account (AWS, Azure, Google Cloud and more), which stops itself when you're done."
                />
                <Feature
                  icon="shield"
                  title="Real targets"
                  description="Exploit genuinely vulnerable systems from an attack box plugged into the lab network."
                />
                <Feature
                  icon="plug"
                  title="Launch from anywhere"
                  description="Start a lab from the website, even on your phone; it runs on the machine you pick."
                />
              </div>
              <Button variant="primary" size="lg" className="mt-8 w-full" onClick={next}>
                Get started
              </Button>
            </div>
          )}

          {step === "signin" && (
            <div>
              <StepHeader
                icon={<Icon name="user" className="size-6 text-foreground" />}
                title="Sign in"
                description="Connect your Cyber CTF account to register this machine and launch labs from any device."
              />
              <div className="mt-8">
                {auth?.loggedIn ? (
                  <div className="flex items-center gap-3 rounded-control border border-success/25 bg-success/10 p-3.5">
                    <span className="flex size-7 items-center justify-center rounded-full bg-success/15 text-success">
                      <Icon name="check" className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-foreground">Signed in{auth.name ? ` as ${auth.name}` : ""}</p>
                      {auth.email && <p className="text-xs text-muted-foreground">{auth.email}</p>}
                    </div>
                  </div>
                ) : (
                  <>
                    <Button variant="primary" size="lg" className="w-full" onClick={login} disabled={loggingIn}>
                      {loggingIn ? (
                        <>
                          <Spinner className="size-4" /> Waiting for the browser… (up to 5 minutes)
                        </>
                      ) : (
                        "Sign in"
                      )}
                    </Button>
                    <p className="mt-2 text-center text-xs text-muted-foreground">Opens cyberauth.co in your browser. You can also do this later.</p>
                    {loginError && (
                      <p role="alert" className="mt-3 rounded-control border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                        {loginError}
                      </p>
                    )}
                  </>
                )}
              </div>
              <div className="mt-8 flex gap-2">
                <Button variant="outline" className="flex-1" onClick={back}>
                  Back
                </Button>
                <Button className="flex-1" onClick={next}>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {/* A machine step before the machine check answers: just the loader, no step header. */}
          {step !== "welcome" && step !== "signin" && step !== "done" && report === null && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Checking this machine…
            </div>
          )}

          {step !== "welcome" &&
            step !== "signin" &&
            step !== "done" &&
            report !== null &&
            (() => {
              const meta = stepMeta(step, report);
              return (
                <div>
                  <StepHeader icon={<meta.icon className="size-6 text-foreground" />} title={meta.title} description={meta.description} />
                  <div className="mt-8">
                    <ErrorBoundary resetKey={step} title="This step couldn’t load">
                      <MachineStepBody step={step} report={report} setup={setup} />
                    </ErrorBoundary>
                  </div>
                  <div className="mt-8 flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={back} disabled={setup.busy}>
                      Back
                    </Button>
                    <Button className="flex-1" onClick={next} disabled={setup.busy || !canContinue(step, report, setup)}>
                      {nextLabel(step, report)}
                    </Button>
                  </div>
                </div>
              );
            })()}

          {step === "done" && (
            <div>
              <StepHeader
                icon={<Icon name="sparkles" className="size-6 text-foreground" />}
                title="You’re all set"
                description="You can change any of this later in Settings or This machine."
              />
              <div className="mt-8 space-y-2.5">
                <SummaryRow
                  ok={!!auth?.loggedIn}
                  label="Account"
                  value={auth?.loggedIn ? `Signed in${auth.name ? ` as ${auth.name}` : ""}` : "Not signed in"}
                />
              </div>
              <div className="mt-2.5">
                <SetupOutcome report={report} setup={setup} />
              </div>
              <Button variant="primary" size="lg" className="mt-8 w-full" onClick={onComplete}>
                Browse labs
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
