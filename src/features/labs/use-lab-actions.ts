"use client";

import { useCallback } from "react";
import { serverList, labLaunch, labStop, type Provider } from "@/lib/tauri";
import { getAttackImage, getVmProvider } from "@/lib/settings";
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
export function useLabActions(refresh: (lab: Lab) => void) {
  const { runs } = useDeploy();

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
      report?: { vagrant: { installed: boolean }; vmProviders: { provider: Provider; remote: boolean; available: boolean; hypervisor?: boolean | null }[] } | null,
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
        if (vm && !remote && provider === null) {
          throw new Error(
            `No hypervisor for this lab is installed on this machine (it runs on ${local.join(", ") || "none"}). Install one from the Machine page, or run it on a server.`,
          );
        }
        // Remotely, or inside a local VM, the lab network isn't reachable from here: start
        // the attack box next to the lab.
        const attackbox = remote || inLocalVm ? getAttackImage() : null;
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
        endDeploy(lab.id);
        refresh(lab);
      }
    },
    [refresh],
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
        endDeploy(lab.id);
        refresh(lab);
      }
    },
    [refresh],
  );

  return { runs, launch, stop };
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
