"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import {
  authLogin,
  authStatus,
  installDependency,
  machineOpenSetup,
  systemCheck,
  type AuthStatus,
  type SystemReport,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

const STEP_COUNT = 4;

function StepHeader({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <div className="text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-border bg-surface">
        <Icon name={icon} className="size-6 text-foreground" />
      </div>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Feature({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
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
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-6 items-center justify-center rounded-full", ok ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground")}>
          <Icon name={ok ? "check" : "arrowRight"} className="size-3.5" />
        </span>
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <span className={cn("text-xs", ok ? "text-emerald-500" : "text-muted-foreground")}>{value}</span>
    </div>
  );
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [report, setReport] = useState<SystemReport | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installerOpened, setInstallerOpened] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);

  const refreshReport = () => systemCheck().then(setReport).catch(() => setReport(null));
  useEffect(() => {
    authStatus().then(setAuth).catch(() => setAuth(null));
    refreshReport();
  }, []);
  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [logs]);

  const dockerReady = report ? report.docker.installed && report.dockerRunning : false;
  const next = () => setStep((s) => Math.min(s + 1, STEP_COUNT - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  async function login() {
    setLoggingIn(true);
    try {
      setAuth(await authLogin());
    } catch {
      /* cancelled or failed - stay on this step */
    } finally {
      setLoggingIn(false);
    }
  }

  async function installDocker() {
    setInstalling(true);
    setLogs([]);
    try {
      await installDependency("docker", (line) => setLogs((l) => [...l, line]));
      setInstallerOpened(true);
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setInstalling(false);
      refreshReport();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Draggable title bar (Overlay style has no native bar); room for traffic lights. */}
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-between pr-4 pl-20">
        <div className="pointer-events-none flex items-center gap-2">
          <Image src="/logo-mark.svg" alt="" width={18} height={18} className="size-[18px]" priority />
          <span className="text-xs font-medium tracking-tight text-muted-foreground">Cyber CTF</span>
        </div>
        {step < STEP_COUNT - 1 && (
          <button onClick={onComplete} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            Skip setup
          </button>
        )}
      </div>

      {/* Progress segments */}
      <div className="mx-auto flex w-full max-w-md gap-1.5 px-6 pt-1">
        {Array.from({ length: STEP_COUNT }).map((_, i) => (
          <div key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i <= step ? "bg-learn" : "bg-muted")} />
        ))}
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div key={step} className="w-full max-w-md animate-rise-in">
          {step === 0 && (
            <div>
              <div className="text-center">
                <div className="mx-auto flex size-16 items-center justify-center rounded-2xl border border-border bg-surface">
                  <Image src="/logo-mark.svg" alt="" width={36} height={36} className="size-9" priority />
                </div>
                <h1 className="mt-6 text-2xl font-semibold tracking-tight">Welcome to Cyber CTF</h1>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                  Run realistic, isolated security labs on your own machine, launched from the app or straight from the website.
                </p>
              </div>
              <div className="mt-8 space-y-2.5">
                <Feature icon="container" title="Container & VM labs" description="Docker containers and full virtual machines, isolated per lab." />
                <Feature icon="shield" title="Real targets" description="Exploit genuinely vulnerable systems, not simulations." />
                <Feature icon="plug" title="Launch from anywhere" description="Start a lab on the website; it runs here on your machine." />
              </div>
              <Button variant="learn" size="lg" className="mt-8 w-full" onClick={next}>Get started</Button>
            </div>
          )}

          {step === 1 && (
            <div>
              <StepHeader icon="user" title="Sign in" description="Connect your Cyber CTF account to register this machine and launch labs from any device." />
              <div className="mt-8">
                {auth?.loggedIn ? (
                  <div className="flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3.5">
                    <span className="flex size-7 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                      <Icon name="check" className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-foreground">Signed in{auth.name ? ` as ${auth.name}` : ""}</p>
                      {auth.email && <p className="text-xs text-muted-foreground">{auth.email}</p>}
                    </div>
                  </div>
                ) : (
                  <>
                    <Button variant="learn" size="lg" className="w-full" onClick={login} disabled={loggingIn}>
                      {loggingIn ? (<><Spinner className="size-4" /> Waiting for the browser…</>) : "Sign in"}
                    </Button>
                    <p className="mt-2 text-center text-xs text-muted-foreground">Opens cyberauth.co in your browser. You can also do this later.</p>
                  </>
                )}
              </div>
              <div className="mt-8 flex gap-2">
                <Button variant="outline" className="flex-1" onClick={back}>Back</Button>
                <Button className="flex-1" onClick={next}>Continue</Button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <StepHeader icon="container" title="Set up this machine" description="Container labs run on Docker. Install it in one click, or set it up later." />
              <div className="mt-8">
                {report === null ? (
                  <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-3.5 text-sm text-muted-foreground">
                    <Spinner className="size-4" /> Checking for Docker…
                  </div>
                ) : dockerReady ? (
                  <div className="flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3.5">
                    <span className="flex size-7 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                      <Icon name="check" className="size-4" />
                    </span>
                    <p className="text-sm font-medium text-foreground">Docker is ready</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5">
                      <div>
                        <p className="text-sm font-medium text-foreground">Docker {report.docker.installed ? "isn’t running" : "isn’t installed"}</p>
                        <p className="text-xs text-muted-foreground">Needed for container labs.</p>
                      </div>
                      {!installerOpened ? (
                        <Button variant="learn" onClick={installDocker} disabled={installing}>
                          {installing ? (<><Spinner className="size-4" /> Installing…</>) : "Install Docker Desktop"}
                        </Button>
                      ) : (
                        <Button variant="outline" onClick={refreshReport}>Re-check</Button>
                      )}
                    </div>
                    {installerOpened && (
                      <p className="text-xs text-muted-foreground">Finish in Docker’s installer, launch Docker Desktop, then press Re-check.</p>
                    )}
                    {logs.length > 0 && (
                      <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                        {logs.join("\n")}
                        <div ref={logEnd} />
                      </pre>
                    )}
                    <button onClick={() => machineOpenSetup().catch(() => {})} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                      Open the step-by-step guide (recommended on Windows)
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-8 flex gap-2">
                <Button variant="outline" className="flex-1" onClick={back}>Back</Button>
                <Button className="flex-1" onClick={next}>{dockerReady ? "Continue" : "I’ll do this later"}</Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <StepHeader icon="sparkles" title="You’re all set" description="You can change any of this later in Settings or This machine." />
              <div className="mt-8 space-y-2.5">
                <SummaryRow ok={!!auth?.loggedIn} label="Account" value={auth?.loggedIn ? `Signed in${auth.name ? ` as ${auth.name}` : ""}` : "Not signed in"} />
                <SummaryRow ok={dockerReady} label="Docker" value={dockerReady ? "Ready" : "Set up later"} />
              </div>
              <Button variant="learn" size="lg" className="mt-8 w-full" onClick={onComplete}>Browse labs</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
