"use client";

import { useCallback, useState } from "react";
import { serverList, labLaunch, labStop } from "@/lib/tauri";
import { getAttackImage } from "@/lib/settings";
import { notify } from "@/lib/notify";
import type { Lab } from "@/lib/use-labs";

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
   * go to the default server host when the lab supports its hypervisor.
   */
  const launch = useCallback(
    async (lab: Lab, host?: string | null) => {
      if (!lab.runtime) return;
      setBusy(lab.id);
      setActiveLab(lab.id);
      setLogs([]);
      try {
        const vm = lab.runtime.runtime === "VM";
        if (vm && host === undefined) host = await defaultHostFor(lab);
        // Docker labs go to a server host only when one is picked explicitly.
        const remote = host != null;
        // Locally, use the first provider the lab supports that isn't a remote hypervisor.
        const provider = vm && !remote ? (lab.runtime.providers.find((p) => p !== "vmware_esxi" && p !== "proxmox") ?? null) : null;
        // Remotely the lab network isn't reachable from here: start the attack box next to it.
        await labLaunch(lab.id, provider, remote ? host! : null, remote ? getAttackImage() : null, (line) => setLogs((l) => [...l, line]));
        setLogs((l) => [...l, "✓ Lab is running"]);
        notify("Lab ready", remote ? `${lab.title} is running on your server.` : `${lab.title} is running on this machine.`);
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
