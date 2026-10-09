"use client";

import { ErrorBoundary } from "@/components/error-screen";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { CtfMark } from "@/components/brand/mark";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { StatusDot } from "@/components/ui/status-pill";
import { TypeIcon } from "@/components/ui/type-icon";
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
import { useT, type MessageKey } from "@/lib/i18n";

type OnboardingStep = "welcome" | "signin" | MachineStep | "done";

/** Names for the progress line. VM steps are optional: Docker labs run without them. */
const STEP_NAMES: Record<OnboardingStep, MessageKey> = {
  welcome: "onboarding.stepNames.welcome",
  signin: "onboarding.stepNames.signin",
  pkgmgr: "onboarding.stepNames.pkgmgr",
  virtualization: "onboarding.stepNames.virtualization",
  docker: "onboarding.stepNames.docker",
  "docker-test": "onboarding.stepNames.dockerTest",
  attack: "onboarding.stepNames.attack",
  vm: "onboarding.stepNames.vm",
  vagrant: "onboarding.stepNames.vagrant",
  "vm-test": "onboarding.stepNames.vmTest",
  done: "onboarding.stepNames.done",
};

const em = (s: string) => <em>{s}</em>;

function StepHeader({ title, description }: { title: ReactNode; description: string }) {
  return (
    <div className="text-center">
      <h1 className="page-title">{title}</h1>
      <p className="mx-auto mt-3 max-w-sm text-[0.875rem] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function Feature({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <TypeIcon>
        <Icon name={icon} className="size-4" />
      </TypeIcon>
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[0.75rem] leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function SummaryRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <Panel className="flex min-h-[3.25rem] items-center justify-between gap-4 px-4">
      <div className="flex items-center gap-2.5">
        <StatusDot tone={ok ? "ok" : "muted"} />
        <span className="text-[0.8125rem] font-medium text-foreground">{label}</span>
      </div>
      <span className={cn("text-[0.75rem]", ok ? "text-foreground" : "text-muted-foreground")}>{value}</span>
    </Panel>
  );
}

/** Back (ghost) on the left, the step's single primary action on the right. */
function StepActions({
  onBack,
  onNext,
  nextLabel,
  disabled,
  backDisabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel: ReactNode;
  disabled?: boolean;
  backDisabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-8 flex items-center justify-between gap-2">
      <Button variant="ghost" onClick={onBack} disabled={backDisabled}>
        <ArrowLeft className="size-4" /> {t("onboarding.back")}
      </Button>
      <Button onClick={onNext} disabled={disabled}>
        {nextLabel}
      </Button>
    </div>
  );
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const t = useT();
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

  const pos = Math.min(i, steps.length - 1);
  const meta = step !== "welcome" && step !== "signin" && step !== "done" && report !== null ? stepMeta(step, report, t) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Draggable title bar (Overlay style has no native bar); room for traffic lights. */}
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-end pr-4 pl-20">
        {step !== "done" && (
          <Button variant="ghost" size="xs" onClick={onComplete}>
            {t("onboarding.skip")}
          </Button>
        )}
      </div>

      <div className="flex flex-1 justify-center overflow-y-auto px-6 pt-6 pb-12">
        <div className="my-auto w-full max-w-lg">
          {/* The mark, then the step position: dots and a mono "3 / 9 · Step name". */}
          <div className="flex flex-col items-center">
            <CtfMark className="size-12" />
            <div className="mt-6 flex items-center gap-1.5" aria-hidden>
              {steps.map((_, n) => (
                <span
                  key={n}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-300",
                    n === pos ? "w-4 bg-jewel-solid" : n < pos ? "w-1.5 bg-muted-foreground" : "w-1.5 bg-border-strong",
                  )}
                />
              ))}
            </div>
            <p className="mt-2.5 flex items-center gap-1.5 font-mono text-[0.6875rem] text-faint">
              {meta && <meta.icon className="size-3" />}
              {pos + 1} / {steps.length} · {t(STEP_NAMES[step])}
            </p>
          </div>

          <div key={step} className="mt-8 animate-rise-in">
            {step === "welcome" && (
              <div>
                <StepHeader title={<>{t.rich("onboarding.welcome.title", { em })}</>} description={t("onboarding.welcome.description")} />
                <Panel className="mt-8">
                  <Feature icon="container" title={t("onboarding.welcome.labsTitle")} description={t("onboarding.welcome.labsDescription")} />
                  <Feature icon="cloud" title={t("onboarding.welcome.whereTitle")} description={t("onboarding.welcome.whereDescription")} />
                  <Feature icon="shield" title={t("onboarding.welcome.targetsTitle")} description={t("onboarding.welcome.targetsDescription")} />
                  <Feature icon="plug" title={t("onboarding.welcome.launchTitle")} description={t("onboarding.welcome.launchDescription")} />
                </Panel>
                <div className="mt-8 flex justify-center">
                  <Button size="lg" className="min-w-48" onClick={next}>
                    {t("onboarding.welcome.start")} <ArrowRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}

            {step === "signin" && (
              <div>
                <StepHeader title={t("onboarding.signin.title")} description={t("onboarding.signin.description")} />
                <div className="mt-8">
                  {auth?.loggedIn ? (
                    <Panel className="flex items-center gap-3 px-4 py-3.5">
                      <StatusDot tone="ok" />
                      <div className="min-w-0">
                        <p className="text-[0.8125rem] font-medium text-foreground">
                          {auth.name ? t("onboarding.signin.signedInAs", { name: auth.name }) : t("onboarding.signin.signedIn")}
                        </p>
                        {auth.email && <p className="truncate font-mono text-[0.6875rem] text-faint">{auth.email}</p>}
                      </div>
                    </Panel>
                  ) : (
                    <Panel className="px-5 py-5 text-center">
                      <Button variant="outline" size="lg" className="w-full" onClick={login} disabled={loggingIn}>
                        {loggingIn ? (
                          <>
                            <Spinner className="size-4" /> {t("onboarding.signin.waiting")}
                          </>
                        ) : (
                          <>
                            <Icon name="user" className="size-4" /> {t("onboarding.signin.button")}
                          </>
                        )}
                      </Button>
                      <p className="mt-2.5 text-[0.75rem] text-muted-foreground">
                        {t.rich("onboarding.signin.hint", { mono: (s) => <span className="font-mono text-[0.6875rem]">{s}</span> })}
                      </p>
                      {loginError && (
                        <p role="alert" className="surface-log mt-4 flex items-start gap-2 rounded-control p-3 text-left text-[0.75rem] text-foreground">
                          <StatusDot tone="fail" className="mt-[0.3rem]" />
                          <span className="min-w-0 break-words">{loginError}</span>
                        </p>
                      )}
                    </Panel>
                  )}
                </div>
                <StepActions onBack={back} onNext={next} nextLabel={t("onboarding.continue")} />
              </div>
            )}

            {/* A machine step before the machine check answers: just the loader, no step header. */}
            {step !== "welcome" && step !== "signin" && step !== "done" && report === null && (
              <div className="flex items-center justify-center gap-2 text-[0.8125rem] text-muted-foreground">
                <Spinner className="size-4" /> {t("onboarding.checking")}
              </div>
            )}

            {step !== "welcome" && step !== "signin" && step !== "done" && report !== null && meta && (
              <div>
                <StepHeader title={meta.title} description={meta.description} />
                <div className="mt-8">
                  <ErrorBoundary resetKey={step} title={t("onboarding.stepFailed")}>
                    <MachineStepBody step={step} report={report} setup={setup} />
                  </ErrorBoundary>
                </div>
                <StepActions
                  onBack={back}
                  backDisabled={setup.busy}
                  onNext={next}
                  disabled={setup.busy || !canContinue(step, report, setup)}
                  nextLabel={nextLabel(step, report, t)}
                />
              </div>
            )}

            {step === "done" && (
              <div>
                <StepHeader title={<>{t.rich("onboarding.done.title", { em })}</>} description={t("onboarding.done.description")} />
                <div className="mt-8 space-y-2.5">
                  <SummaryRow
                    ok={!!auth?.loggedIn}
                    label={t("onboarding.done.account")}
                    value={
                      auth?.loggedIn
                        ? auth.name
                          ? t("onboarding.signin.signedInAs", { name: auth.name })
                          : t("onboarding.signin.signedIn")
                        : t("onboarding.done.notSignedIn")
                    }
                  />
                  <SetupOutcome report={report} setup={setup} />
                </div>
                <div className="mt-8 flex justify-center">
                  <Button size="lg" className="min-w-48" onClick={onComplete}>
                    {t("onboarding.done.browse")} <ArrowRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
