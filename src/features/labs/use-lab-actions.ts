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
 * opens Settings) and comes back. UI reads `busy` / `activeLab` / `logs`.
 */
export function useLabActions(refresh: (lab: Lab) => void) {
  const { busy, activeLab, logs, times } = useDeploy();

  /**
   * `host` = a server host id to run a VM lab on, null for this machine. Omitted, VM labs
   * go to the default server host when the lab supports its hypervisor. `vmProvider` runs a
   * container lab in a VM on this machine (its deploy/vagrant lab host) on that hypervisor.
   */
  const launch = useCallback(
    async (lab: Lab, host?: string | null, vmProvider?: Provider) => {
      if (!lab.runtime) return;
      beginDeploy(lab.id);
      try {
        const vm = lab.runtime.runtime === "VM";
        if (vm && host === undefined) host = await defaultHostFor(lab);
        // Docker labs go to a server host only when one is picked explicitly.
        const remote = host != null;
        // Locally: the hypervisor picked in Settings when the lab supports it, else the
        // first provider the lab supports that isn't a remote hypervisor.
        const preferred = getVmProvider();
        const local: Provider[] = lab.runtime.providers.filter((p) => p !== "vmware_esxi" && p !== "proxmox");
        const inLocalVm = !vm && !remote && !!vmProvider;
        const provider = inLocalVm ? vmProvider! : vm && !remote ? ((preferred && local.includes(preferred) ? preferred : local[0]) ?? null) : null;
        // Remotely, or inside a local VM, the lab network isn't reachable from here: start
        // the attack box next to the lab.
        const attackbox = remote || inLocalVm ? getAttackImage() : null;
        await labLaunch(lab.id, provider, remote ? host! : null, attackbox, (line) => appendDeployLog(line));
        appendDeployLog("✓ Lab is running");
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
        appendDeployLog(`✗ ${String(e)}`);
      } finally {
        endDeploy();
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
        await labStop(lab.id, lab.runtime.runtime, (line) => appendDeployLog(line));
        appendDeployLog("✓ Lab stopped");
      } catch (e) {
        appendDeployLog(`✗ ${String(e)}`);
      } finally {
        endDeploy();
        refresh(lab);
      }
    },
    [refresh],
  );

  return { busy, activeLab, logs, times, launch, stop };
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
