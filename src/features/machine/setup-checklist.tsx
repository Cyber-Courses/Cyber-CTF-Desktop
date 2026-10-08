"use client";

import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StepRow } from "@/features/machine/step-row";
import { machineSteps, stepMeta, type MachineStep } from "@/features/machine/setup-steps";
import { hasHypervisor, isDockerReady } from "@/features/machine/setup-steps/steps";
import { engineName } from "@/features/machine/setup-steps/engines";
import { usableHypervisors, providerLabel } from "@/features/machine/hypervisors";
import { ATTACK_PRESETS, getAttackImage, type LastTest } from "@/lib/settings";
import { machineOpenSetup, type SystemReport } from "@/lib/tauri";
import { tell } from "@/lib/failure";

type Line = { done: boolean; optional?: boolean; meta: string };

/** Where this machine stands on each guided-setup step, read from the system report and the
 *  last self-tests. The steps themselves run in the setup window. */
function stepLine(step: MachineStep, report: SystemReport, last: Record<"docker" | "vm", LastTest | null>): Line {
  const hv = usableHypervisors(report).find((p) => p.hypervisor === true);
  switch (step) {
    case "pkgmgr":
      return { done: report.pkgManager.installed, meta: report.pkgManager.installed ? report.pkgManager.name : "not installed" };
    case "virtualization":
      return { done: isDockerReady(report), meta: isDockerReady(report) ? "WSL 2" : "not checked" };
    case "docker":
      return {
        done: isDockerReady(report),
        meta: isDockerReady(report)
          ? report.dockerEngine
            ? engineName(report.dockerEngine)
            : "running"
          : report.docker.installed
            ? "stopped"
            : "not installed",
      };
    case "docker-test":
      return { done: last.docker?.result === "ok", meta: last.docker ? (last.docker.result === "ok" ? "passed" : "failed") : "not tested" };
    case "attack": {
      const image = getAttackImage();
      return { done: true, meta: ATTACK_PRESETS.find((p) => p.image === image)?.label ?? image };
    }
    case "vm":
      return { done: hasHypervisor(report), optional: true, meta: hv ? providerLabel(hv, report.os) : "optional" };
    case "vagrant": {
      const ok = report.vagrant.installed && (!hv?.plugin || hv.pluginInstalled);
      return {
        done: ok,
        optional: !hasHypervisor(report),
        meta: report.vagrant.installed ? (ok ? "installed" : `plugin ${hv?.plugin} missing`) : "not installed",
      };
    }
    case "vm-test":
      return {
        done: last.vm?.result === "ok",
        optional: !hasHypervisor(report),
        meta: last.vm ? (last.vm.result === "ok" ? "passed" : "failed") : "not tested",
      };
  }
}

/** The Machine page's Setup view: each guided-setup step as a checklist row, with a way into
 *  the setup window at that step. */
export function SetupChecklist({
  report,
  last,
  onFix,
}: {
  report: SystemReport;
  last: Record<"docker" | "vm", LastTest | null>;
  onFix: (step: string) => void;
}) {
  const steps = machineSteps(report).map((step) => ({ step, title: stepMeta(step, report).title, ...stepLine(step, report, last) }));
  const done = steps.filter((s) => s.done).length;
  return (
    <Panel>
      <PanelHeader
        title="Guided setup"
        meta={
          <span className="tabular-nums">
            {done} of {steps.length} done
          </span>
        }
        action={
          // The page header carries the primary "Set up this machine" when something is missing.
          <Button variant="outline" size="xs" onClick={() => machineOpenSetup().catch(tell("Couldn't open machine setup"))}>
            <Wrench /> Open guided setup
          </Button>
        }
      />
      <div className="py-1.5">
        {steps.map((s) => (
          <StepRow
            key={s.step}
            state={s.done ? "done" : "pending"}
            label={s.title}
            meta={s.meta}
            action={
              !s.done && (
                <Button variant={s.optional ? "ghost" : "outline"} size="xs" onClick={() => onFix(s.step)}>
                  {s.step.endsWith("-test") ? "Test" : s.optional ? "Add" : "Set up"}
                </Button>
              )
            }
          />
        ))}
      </div>
    </Panel>
  );
}
