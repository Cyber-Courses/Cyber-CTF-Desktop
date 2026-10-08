"use client";

/**
 * The machine-setup steps, shared by the "Set up this machine" window and the first-run
 * onboarding. Each flow owns its own frame (header style, progress, nav buttons); the step
 * list, titles, bodies and install/test state all live here, so a change shows up in both.
 */

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelfTest } from "@/features/machine/self-test";
import { type SystemReport } from "@/lib/tauri";
import { AttackStep } from "@/features/machine/setup-steps/attack-step";
import { EngineStep } from "@/features/machine/setup-steps/engine-step";
import { CmdRow, Log, Num, Outcome, Requirement, Skipped } from "@/features/machine/setup-steps/parts";
import { MachineStep, hasHypervisor, isDockerReady } from "@/features/machine/setup-steps/steps";
import { MachineSetupState } from "@/features/machine/setup-steps/use-machine-setup";
import { VagrantStep, VmStep } from "@/features/machine/setup-steps/vm-steps";
import { openExternal } from "@/lib/failure";

/** The body of one setup step (no header, no nav: the flow draws those). */
export function MachineStepBody({ step, report, setup }: { step: MachineStep; report: SystemReport; setup: MachineSetupState }) {
  const isWin = report.os === "windows";
  const isMac = report.os === "macos";

  if (step === "pkgmgr") {
    if (report.pkgManager.installed) {
      return (
        <div className="overflow-hidden rounded-lg border border-border">
          <Requirement ok title={report.pkgManager.name} detail={report.pkgManager.version ?? "Installed"} action={null} />
        </div>
      );
    }
    return (
      <>
        {isMac && (
          <div className="space-y-2">
            <p className="text-[0.78125rem] text-muted-foreground">Run this in Terminal, then come back, it’s detected automatically:</p>
            <CmdRow cmd={'/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'} />
            <button onClick={() => openExternal("https://brew.sh")} className="inline-flex items-center gap-1.5 text-[0.75rem] text-learn hover:underline">
              <ExternalLink className="size-3.5" /> brew.sh
            </button>
          </div>
        )}
        {isWin && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[#0f0f0f] p-3.5">
            <div>
              <p className="text-[0.8125rem] font-medium">App Installer (winget)</p>
              <p className="text-[0.75rem] text-muted-foreground">Install it from the Microsoft Store, then come back.</p>
            </div>
            <Button variant="learn" onClick={() => openExternal("https://apps.microsoft.com/detail/9nblggh4nns1")}>
              <ExternalLink className="size-3.5" /> Get
            </Button>
          </div>
        )}
        {!isMac && !isWin && (
          <p className="text-[0.78125rem] text-muted-foreground">
            Install your distribution’s package manager{report.pkgManager.name ? ` (${report.pkgManager.name})` : ""} to use the one-click installs.
          </p>
        )}
      </>
    );
  }

  if (step === "virtualization") {
    const installing = setup.installing === "wsl";
    const tried = !installing && setup.logs.length > 0 && setup.logs[0].startsWith("Turning on WSL");
    return (
      <>
        <p className="text-[0.8125rem] text-muted-foreground">
          Cyber CTF turns on WSL 2 for you. Windows asks for permission once (the usual admin prompt), then needs a restart.
        </p>
        <Button
          variant="learn"
          className="mt-4"
          disabled={setup.busy}
          onClick={() => setup.install("wsl", "wsl", "Turning on WSL 2. Accept the Windows prompt to continue…")}
        >
          {installing ? "Turning on WSL 2…" : "Turn on WSL 2"}
        </Button>
        <div className="mt-3">
          <Log setup={setup} />
        </div>
        {tried && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[0.8125rem] text-amber-200">
            Restart Windows to finish, then open Cyber CTF again to continue setup.
          </p>
        )}
        <details className="mt-4 text-[0.78125rem] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Do it by hand instead</summary>
          <ol className="mt-3 space-y-3">
            <Num n={1}>
              Open <b>PowerShell</b> as Administrator (right-click → “Run as administrator”).
            </Num>
            <Num n={2}>
              Run this, then reboot when it finishes:
              <div className="mt-1.5">
                <CmdRow cmd="wsl --install" />
              </div>
            </Num>
            <Num n={3}>
              If Docker later says virtualization is off: open “Turn Windows features on or off” and enable <b>Virtual Machine Platform</b> and{" "}
              <b>Windows Subsystem for Linux</b>, and make sure virtualization is enabled in your BIOS/UEFI.
            </Num>
          </ol>
          <button
            onClick={() => openExternal("https://learn.microsoft.com/windows/wsl/install")}
            className="mt-4 inline-flex items-center gap-1.5 text-[0.75rem] text-learn hover:underline"
          >
            <ExternalLink className="size-3.5" /> Microsoft’s WSL install guide
          </button>
        </details>
      </>
    );
  }

  if (step === "docker") return <EngineStep report={report} setup={setup} />;
  if (step === "attack") return <AttackStep report={report} />;
  if (step === "vm") return <VmStep report={report} setup={setup} />;
  if (step === "vagrant") return <VagrantStep report={report} setup={setup} />;

  if (step === "docker-test") {
    return isDockerReady(report) ? (
      <SelfTest kind="docker" title="Container lab test" description="busybox, two containers on a lab network." auto onResult={setup.setDockerTest} />
    ) : (
      <Skipped title="Nothing to test yet" reason="No container engine is running. Go back to set one up, or skip for now." />
    );
  }

  return hasHypervisor(report) ? (
    <SelfTest kind="vm" title="VM lab test" description="Boots, runs a command, pings it on a lab network, deletes it." auto onResult={setup.setVmTest} />
  ) : (
    <Skipped title="Nothing to test yet" reason="No hypervisor is installed. Go back to install one, or skip for now." />
  );
}

/** End-of-setup summary: what this machine can run, from the test results. */
export function SetupOutcome({ report, setup }: { report: SystemReport | null; setup: MachineSetupState }) {
  const { dockerTest, vmTest } = setup;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Outcome
        title="Container labs"
        ok={dockerTest === "ok"}
        detail={
          dockerTest === "ok"
            ? "Tested and ready to run."
            : dockerTest === "fail"
              ? "The test failed. Go back to run it again."
              : isDockerReady(report)
                ? "Engine running, not tested."
                : "Set up a container engine to run them."
        }
      />
      <Outcome
        title="VM labs"
        ok={vmTest === "ok"}
        detail={
          vmTest === "ok"
            ? "Tested and ready to run."
            : vmTest === "fail"
              ? "The test failed. Go back to run it again."
              : hasHypervisor(report)
                ? "Not tested."
                : "Install a hypervisor to run them."
        }
      />
    </div>
  );
}

// The setup flow's public surface (machine setup window, onboarding, Machine and Servers pages).
export { canContinue, machineSteps, nextLabel, stepMeta, type MachineStep } from "@/features/machine/setup-steps/steps";
export { useMachineSetup, type MachineSetupState } from "@/features/machine/setup-steps/use-machine-setup";
export { EngineMark } from "@/features/machine/setup-steps/engine-step";
export { engineName } from "@/features/machine/setup-steps/engines";
export { Requirement } from "@/features/machine/setup-steps/parts";
