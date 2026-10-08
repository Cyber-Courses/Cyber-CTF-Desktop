"use client";

import { ArrowLeft, ExternalLink, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { Requirement } from "@/features/machine/setup-steps";
import { installDependency, installVagrantPlugin } from "@/lib/tauri";
import { CLOUD_META, KIND } from "@/features/servers/host-setup/constants";
import { Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";
import { openExternal } from "@/lib/failure";

export function ToolsStep({ s }: { s: HostSetup }) {
  const {
    report,
    onRefresh,
    v,
    pluginLog,
    toolLabel,
    cloudProvider,
    cloud,
    kind,
    next,
    back,
    toolBusy,
    installTool,
    vagrantOk,
    esxiPluginOk,
    ovftoolOk,
    terraformOk,
    cloudDep,
    cloudHasCli,
    cloudCliTool,
    cloudCliOk,
    toolsOk,
  } = s;
  return (
    <Step
      icon={HardDrive}
      title={cloud ? "Command-line tools" : "Tools on this machine"}
      description={
        cloud
          ? cloudHasCli
            ? `The ${CLOUD_META[cloudProvider].label} CLI and Terraform, used to connect and provision.`
            : `Terraform connects to ${CLOUD_META[cloudProvider].label} with your API token and provisions the lab. No CLI needed.`
          : `What the launcher needs here to run labs on ${KIND[v.provider].label}.`
      }
    >
      <div className="surface-panel overflow-hidden rounded-control">
        {!report ? (
          <div className="flex items-center gap-2 px-4 py-3 text-[0.8125rem] text-muted-foreground">
            <Spinner className="size-4" /> Checking this machine…
          </div>
        ) : cloud ? (
          <>
            {cloudHasCli && (
              <Requirement
                ok={cloudCliOk}
                title={`${CLOUD_META[cloudProvider].label} CLI`}
                detail={cloudCliOk ? (cloudCliTool?.version ?? "Installed") : `The ${CLOUD_META[cloudProvider].cli} CLI, needed to connect and provision.`}
                action={
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={toolBusy}
                    onClick={() => installTool(`${CLOUD_META[cloudProvider].cli} CLI`, (log) => installDependency(cloudDep, log))}
                  >
                    Install {CLOUD_META[cloudProvider].cli}
                  </Button>
                }
              />
            )}
            <Requirement
              ok={terraformOk}
              title="Terraform"
              detail={
                terraformOk
                  ? (report?.terraform.version ?? "Installed")
                  : "Creates and destroys the cloud lab. Its provider plugins are fetched automatically on first run."
              }
              action={
                <Button variant="outline" size="xs" disabled={toolBusy} onClick={() => installTool("Terraform", (log) => installDependency("terraform", log))}>
                  Install Terraform
                </Button>
              }
            />
          </>
        ) : v.provider === "vmware_esxi" ? (
          <>
            <Requirement
              ok={vagrantOk}
              title="Vagrant"
              detail={vagrantOk ? (report?.vagrant.version ?? "Installed") : "Builds and runs the lab VMs on the host."}
              action={
                <Button variant="outline" size="xs" disabled={toolBusy} onClick={() => installTool("Vagrant", (log) => installDependency("vagrant", log))}>
                  Install Vagrant
                </Button>
              }
            />
            <Requirement
              ok={esxiPluginOk}
              title="Vagrant plugin for ESXi"
              detail={vagrantOk || esxiPluginOk ? kind.plugin : `${kind.plugin}, once Vagrant is installed.`}
              action={
                <Button
                  variant="outline"
                  size="xs"
                  disabled={toolBusy || !vagrantOk}
                  onClick={() => installTool(kind.plugin, (log) => installVagrantPlugin(kind.plugin, log))}
                >
                  Install plugin
                </Button>
              }
            />
            <Requirement
              ok={ovftoolOk}
              title="VMware OVF Tool"
              detail={
                ovftoolOk
                  ? (report?.ovftool.version ?? "Installed")
                  : "Uploads the lab VMs to ESXi. Comes with VMware Fusion / Workstation, or standalone from Broadcom (free account)."
              }
              action={
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => openExternal("https://developer.broadcom.com/tools/open-virtualization-format-ovf-tool/latest")}
                >
                  <ExternalLink className="size-3" /> Get
                </Button>
              }
            />
          </>
        ) : (
          <Requirement
            ok={terraformOk}
            title="Terraform"
            detail={report?.terraform.installed ? (report.terraform.version ?? "Installed") : "Drives the Proxmox API. Install it to run Proxmox labs."}
            action={
              <Button variant="outline" size="xs" disabled={toolBusy} onClick={() => installTool("Terraform", (log) => installDependency("terraform", log))}>
                Install Terraform
              </Button>
            }
          />
        )}
      </div>
      {pluginLog && (
        <div className="mt-3">
          <LogConsole lines={pluginLog} running={toolBusy} title={`Install ${toolLabel}`} />
        </div>
      )}
      <Nav
        left={
          <Button variant="ghost" onClick={back}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        }
        right={
          <span className="flex gap-2">
            {!toolsOk && (
              <Button variant="outline" onClick={() => onRefresh()}>
                Re-check
              </Button>
            )}
            <Button onClick={next} disabled={!toolsOk}>
              Continue
            </Button>
          </span>
        }
      />
    </Step>
  );
}
