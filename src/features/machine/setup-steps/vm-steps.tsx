"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type SystemReport } from "@/lib/tauri";
import { DOWNLOAD, INSTALLABLE, providerLabel, usableHypervisors } from "@/features/machine/hypervisors";
import { Choice, ChoiceAction, ChoiceGrid, Log, Requirement } from "@/features/machine/setup-steps/parts";
import { chosenHypervisor } from "@/features/machine/setup-steps/steps";
import { MachineSetupState } from "@/features/machine/setup-steps/use-machine-setup";

export function VmStep({ report, setup }: { report: SystemReport; setup: MachineSetupState }) {
  const hypervisors = usableHypervisors(report);
  const { installing, install, onRefresh } = setup;
  // One hypervisor is enough; the pick lives in the setup state so the flow can wait for it.
  const picked = chosenHypervisor(report, setup);
  if (hypervisors.length === 0) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        No local hypervisor applies to this machine. You can run VM labs on a Server (ESXi / Proxmox) instead.
      </p>
    );
  }
  const choice = picked ?? hypervisors[0];
  const label = providerLabel(choice);
  return (
    <div className="space-y-3">
      <ChoiceGrid>
        {hypervisors.map((p) => (
          <Choice
            key={p.provider}
            selected={p.provider === choice.provider}
            onSelect={() => setup.setHypervisor(p.provider)}
            mark={
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Server className="size-4" />
              </span>
            }
            title={providerLabel(p)}
            note={INSTALLABLE[p.provider] ? "Cyber CTF can install it for you." : "Install it from the vendor's site."}
            badge={p.hypervisor === true ? "installed" : undefined}
          />
        ))}
      </ChoiceGrid>
      {/* Only when there is something to do: an installed hypervisor says so on its card. */}
      {choice.hypervisor !== true && (
        <ChoiceAction>
          {INSTALLABLE[choice.provider] ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Cyber CTF can install {label} for you.</span>
              <Button
                variant="learn"
                size="sm"
                onClick={() => install(choice.provider, INSTALLABLE[choice.provider]!, `Installing ${label}…`)}
                disabled={installing !== null}
              >
                {installing === choice.provider ? (
                  <>
                    <Spinner className="size-3.5" /> Installing…
                  </>
                ) : (
                  `Install ${label}`
                )}
              </Button>
            </>
          ) : (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Install {label}, then re-check.</span>
              <span className="flex shrink-0 gap-2">
                {DOWNLOAD[choice.provider] && (
                  <Button variant="outline" size="sm" onClick={() => openUrl(DOWNLOAD[choice.provider]!).catch(() => {})}>
                    <ExternalLink className="size-3.5" /> Get {label}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
              </span>
            </>
          )}
        </ChoiceAction>
      )}
      <Log setup={setup} />
    </div>
  );
}

export function VagrantStep({ report, setup }: { report: SystemReport; setup: MachineSetupState }) {
  const choice = chosenHypervisor(report, setup);
  const { installing, install } = setup;
  if (!choice) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        No local hypervisor applies to this machine, so there is nothing for Vagrant to drive here. VM labs can run on a Server instead.
      </p>
    );
  }
  const label = providerLabel(choice);
  return (
    <div className="space-y-3">
      {/* For the hypervisor picked on the previous step. */}
      <div className="overflow-hidden rounded-lg border border-border">
        <Requirement
          ok={report.vagrant.installed}
          title="Vagrant"
          detail={report.vagrant.installed ? (report.vagrant.version ?? "Installed") : "Creates and starts the lab VMs."}
          action={
            <Button variant="learn" size="sm" onClick={() => install("vagrant", "vagrant", "Installing Vagrant…")} disabled={installing !== null}>
              {installing === "vagrant" ? (
                <>
                  <Spinner className="size-3.5" /> Installing…
                </>
              ) : (
                "Install Vagrant"
              )}
            </Button>
          }
        />
        {choice.plugin && (
          <Requirement
            ok={choice.pluginInstalled}
            title={`${label} add-on for Vagrant`}
            detail={choice.pluginInstalled || report.vagrant.installed ? choice.plugin : `${choice.plugin}, once Vagrant is installed.`}
            action={
              <Button variant="learn" size="sm" onClick={() => setup.installPlugin(choice.plugin!)} disabled={installing !== null || !report.vagrant.installed}>
                {installing === choice.plugin ? (
                  <>
                    <Spinner className="size-3.5" /> Installing…
                  </>
                ) : (
                  "Install plugin"
                )}
              </Button>
            }
          />
        )}
        {choice.provider === "vmware_desktop" && (
          <Requirement
            ok={false}
            optional
            title="Vagrant VMware Utility"
            detail="HashiCorp's helper service the VMware plugin talks to. Install it once."
            action={
              <Button variant="outline" size="sm" onClick={() => openUrl("https://developer.hashicorp.com/vagrant/install/vmware").catch(() => {})}>
                <ExternalLink className="size-3.5" /> Get
              </Button>
            }
          />
        )}
      </div>
      <Log setup={setup} />
    </div>
  );
}

/** One thing the step needs: done (with a check), or its install action. `optional` rows
 *  can't be detected, so they always show their action and never block the flow. */
