"use client";

import { useCallback } from "react";
import { serverList, labLaunch, labPark, labProvision, labResume, labStop, type Park, type Provider } from "@/lib/tauri";
import { getAttackBox, getAttackImage, getAutoAttackBox, getVmProvider } from "@/lib/settings";
import { notify } from "@/lib/notify";
import type { Lab } from "@/features/labs/use-labs";
import { setLastRun } from "@/lib/last-run";
import { appendDeployLog, beginDeploy, endDeploy, useDeploy } from "@/lib/deploy-store";

/**
 * Start/stop actions for labs, shared across screens. The busy lab, its streamed log lines
 * and which lab they belong to live in a module store (deploy-store), so a deploy started
 * here keeps streaming and stays visible even after the labs screen unmounts (e.g. the user
 * opens Settings) and comes back. Keyed per lab, so two deploys at once keep separate logs; the
 * UI reads each lab's run from `runs[labId]`.
 */
export function useLabActions(refresh: (lab: Lab, opts?: { fresh?: boolean }) => Promise<void> | void) {
  const { runs } = useDeploy();

  // An operation stays busy until the lab's status after it has been read: cleared earlier, the
  // page showed the old status's buttons (Shut down on a lab just shut down) for a few seconds,
  // and a click there started the same operation again. Capped, so a hung read never pins it.
  const settle = useCallback(
    async (lab: Lab) => {
      await Promise.race([Promise.resolve(refresh(lab, { fresh: true })), new Promise((r) => setTimeout(r, 20_000))]);
      endDeploy(lab.id);
    },
    [refresh],
  );

  /**
   * `host` = a server host id to run a VM lab on, null for this machine. Omitted, VM labs
   * go to the default server host when the lab supports its hypervisor. `vmProvider` runs a
   * container lab in a VM on this machine (its deploy/vagrant lab host) on that hypervisor.
   */
  const launch = useCallback(
    async (
      lab: Lab,
      host?: string | null,
      vmProvider?: Provider,
      /** The machine report, to pick a hypervisor that is actually installed here. */
      report?: {
        arch?: string;
        vagrant: { installed: boolean };
        vmProviders: { provider: Provider; remote: boolean; available: boolean; hypervisor?: boolean | null }[];
      } | null,
    ) => {
      if (!lab.runtime) return;
      beginDeploy(lab.id);
      try {
        const vm = lab.runtime.runtime === "VM";
        if (vm && host === undefined) host = await defaultHostFor(lab);
        // Docker labs go to a server host only when one is picked explicitly.
        const remote = host != null;
        const preferred = getVmProvider();
        // Hypervisors ready on this machine (Vagrant + the tool), the Settings default first;
        // unknown (undefined) until the machine report has loaded.
        const ready: Provider[] | undefined = report
          ? (() => {
              const r = report.vagrant.installed
                ? report.vmProviders.filter((p) => !p.remote && p.available && p.hypervisor !== false).map((p) => p.provider)
                : [];
              return preferred && r.includes(preferred) ? [preferred, ...r.filter((p) => p !== preferred)] : r;
            })()
          : undefined;
        // Locally: a ready hypervisor among those the lab supports. Never the lab's first
        // listed provider: the catalogue lists them alphabetically, and picking e.g. "parallels"
        // on a VirtualBox machine fails at once with "prlctl was not found". With no report yet,
        // fall back to the Settings preference, then the first supported one.
        const local: Provider[] = lab.runtime.providers.filter((p) => p !== "vmware_esxi" && p !== "proxmox");
        const inLocalVm = !vm && !remote && !!vmProvider;
        const provider = inLocalVm
          ? vmProvider!
          : vm && !remote
            ? ready === undefined
              ? ((preferred && local.includes(preferred) ? preferred : local[0]) ?? null)
              : (ready.find((p) => local.includes(p)) ?? null)
            : null;
        // x86 VMs (Windows AD labs) can't boot on an Apple Silicon hypervisor; say so up front
        // instead of failing deep in Vagrant.
        const archs = lab.runtime.architectures;
        if (vm && !remote && report?.arch && archs.length && !archs.includes(report.arch)) {
          throw new Error(
            `This lab's VMs are built for ${archs.join(", ")} and this machine is ${report.arch}, so its hypervisors can't run them. Run it on a server or in your cloud account instead.`,
          );
        }
        if (vm && !remote && provider === null) {
          throw new Error(
            `No hypervisor for this lab is installed on this machine (it runs on ${local.join(", ") || "none"}). Install one from the Machine page, or run it on a server.`,
          );
        }
        // The lab network isn't reachable from here, so an attack box goes next to the lab.
        // Remotely or inside a local VM: the container attack box image. A VM lab here: the
        // attack VM's Vagrant box, when Settings start the attack box with each lab.
        const attackbox = remote || inLocalVm ? getAttackImage() : vm && getAutoAttackBox() ? getAttackBox() : null;
        await labLaunch(lab.id, provider, remote ? host! : null, attackbox, (line) => appendDeployLog(lab.id, line));
        appendDeployLog(lab.id, "✓ Lab is running");
        setLastRun(lab.id);
        notify(
          "Lab ready",
          remote
            ? `${lab.title} is running on your server.`
            : inLocalVm
              ? `${lab.title} is running in a VM on this machine.`
              : `${lab.title} is running on this machine.`,
        );
      } catch (e) {
        appendDeployLog(lab.id, `✗ ${String(e)}`);
      } finally {
        await settle(lab);
      }
    },
    [settle],
  );

  const stop = useCallback(
    async (lab: Lab) => {
      if (!lab.runtime) return;
      beginDeploy(lab.id);
      try {
        await labStop(lab.id, lab.runtime.runtime, (line) => appendDeployLog(lab.id, line));
        appendDeployLog(lab.id, "✓ Lab stopped");
      } catch (e) {
        appendDeployLog(lab.id, `✗ ${String(e)}`);
      } finally {
        await settle(lab);
      }
    },
    [settle],
  );

  /** Pause (state saved) or shut down (powered off) a lab, keeping its machines for `resume`. */
  const park = useCallback(
    async (lab: Lab, mode: Park) => {
      if (!lab.runtime) return;
      beginDeploy(lab.id);
      try {
        await labPark(lab.id, lab.runtime.runtime, mode, (line) => appendDeployLog(lab.id, line));
        appendDeployLog(lab.id, mode === "pause" ? "✓ Lab paused" : "✓ Lab shut down");
      } catch (e) {
        appendDeployLog(lab.id, `✗ ${String(e)}`);
      } finally {
        await settle(lab);
      }
    },
    [settle],
  );

  /** Bring a parked lab back as it was: no rebuild, no new launch. */
  const resume = useCallback(
    async (lab: Lab) => {
      if (!lab.runtime) return;
      beginDeploy(lab.id);
      try {
        await labResume(lab.id, lab.runtime.runtime, (line) => appendDeployLog(lab.id, line));
        appendDeployLog(lab.id, "✓ Lab is running");
        setLastRun(lab.id);
        notify("Lab ready", `${lab.title} is back.`);
      } catch (e) {
        appendDeployLog(lab.id, `✗ ${String(e)}`);
      } finally {
        await settle(lab);
      }
    },
    [settle],
  );

  /** Re-run a VM lab's provisioning on one machine (or all), streamed into its deploy log. */
  const provision = useCallback(
    async (lab: Lab, machine: string | null) => {
      if (!lab.runtime) return;
      beginDeploy(lab.id);
      try {
        await labProvision(lab.id, lab.runtime.runtime, machine, (line) => appendDeployLog(lab.id, line));
        appendDeployLog(lab.id, machine ? `✓ ${machine} provisioned` : "✓ Lab provisioned");
      } catch (e) {
        appendDeployLog(lab.id, `✗ ${String(e)}`);
      } finally {
        await settle(lab);
      }
    },
    [settle],
  );

  return { runs, launch, stop, park, resume, provision };
}

/** The default server host id, if one is set and the lab supports its hypervisor. */
async function defaultHostFor(lab: Lab): Promise<string | null> {
  try {
    const { default: id, hosts } = await serverList();
    const host = hosts.find((h) => h.id === id);
    // Proxmox can't run labs yet (no working Vagrant provider), so it's never an implicit target.
    return host && host.provider !== "proxmox" && lab.runtime?.providers.includes(host.provider) ? host.id : null;
  } catch {
    return null;
  }
}
