"use client";

import { useCallback, useState } from "react";
import { labLaunch, labStop } from "@/lib/tauri";
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

  const launch = useCallback(
    async (lab: Lab) => {
      if (!lab.runtime) return;
      setBusy(lab.id);
      setActiveLab(lab.id);
      setLogs([]);
      try {
        const provider = lab.runtime.runtime === "VM" ? (lab.runtime.providers[0] ?? null) : null;
        await labLaunch(lab.id, provider, (line) => setLogs((l) => [...l, line]));
        setLogs((l) => [...l, "✓ Lab is running"]);
        notify("Lab ready", `${lab.title} is running on this machine.`);
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
