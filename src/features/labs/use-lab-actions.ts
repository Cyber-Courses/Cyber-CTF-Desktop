"use client";

import { useCallback, useState } from "react";
import { serverList, labLaunch, labStop, type Provider } from "@/lib/tauri";
import { getAttackImage, getVmProvider } from "@/lib/settings";
import { notify } from "@/lib/notify";
import type { Lab } from "@/features/labs/use-labs";
import { setLastRun } from "@/lib/last-run";

/**
 * Start/stop actions for labs, shared across screens. Tracks which lab is busy, the
 * streamed log lines for the lab currently acting (for a console), and refreshes the
 * lab's status when done. UI (console, buttons) reads `busy` / `activeLab` / `logs`.
 */
export function useLabActions(refresh: (lab: Lab) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [activeLab, setActiveLab] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  /**
   * `host` = a server host id to run a VM lab on, null for this machine. Omitted, VM labs
   * go to the default server host when the lab supports its hypervisor. `vmProvider` runs a
   * container lab in a VM on this machine (its deploy/vagrant lab host) on that hypervisor.
   */
  const launch = useCallback(
    async (lab: Lab, host?: string | null, vmProvider?: Provider) => {
      if (!lab.runtime) return;
      setBusy(lab.id);
      setActiveLab(lab.id);
      setLogs([]);
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
        await labLaunch(lab.id, provider, remote ? host! : null, attackbox, (line) => setLogs((l) => [...l, line]));
        setLogs((l) => [...l, "✓ Lab is running"]);
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
        setLogs((l) => [...l, `✗ ${String(e)}`]);
      } finally {
        setBusy(null);
        refresh(lab);
      }
    },
    [refresh],
  );

  const stop = useCallback(
    async (lab: Lab) => {
      if (!lab.runtime) return;
      setBusy(lab.id);
      setActiveLab(lab.id);
      setLogs([]);
      try {
        await labStop(lab.id, lab.runtime.runtime, (line) => setLogs((l) => [...l, line]));
        setLogs((l) => [...l, "✓ Lab stopped"]);
      } catch (e) {
        setLogs((l) => [...l, `✗ ${String(e)}`]);
      } finally {
        setBusy(null);
        refresh(lab);
      }
    },
    [refresh],
  );

  return { busy, activeLab, logs, launch, stop };
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
