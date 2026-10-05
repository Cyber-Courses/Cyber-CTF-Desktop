"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { exegolStart, exegolStatus, exegolStop, type ExegolStatus } from "@/lib/tauri";
import { getAttackImage, getAutoAttackBox } from "@/lib/settings";

/**
 * The lab's attack box: polled while a local container lab is up (so running / IP stay
 * current), started and stopped with a streamed log, and started with the lab when the
 * Settings preference is on (once per run).
 */
export function useAttackBox(labId: string, { running, local }: { running: boolean; local: boolean }) {
  const [status, setStatus] = useState<ExegolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  // Set in Settings; read once per visit.
  const [autoStart] = useState(() => getAutoAttackBox());

  // Only the newest status read wins: a slow poll that was already in flight when the box was
  // stopped must not resolve afterwards with a stale "running" and flip the button back (which
  // made Stop seem to need two or three clicks).
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    exegolStatus(labId, getAttackImage())
      .then((s) => {
        if (mine === seq.current) setStatus(s);
      })
      .catch(() => {
        if (mine === seq.current) setStatus(null);
      });
  }, [labId]);
  useEffect(() => {
    if (!running || !local) return;
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [running, local, refresh]);

  const run = useCallback(
    async (fn: (onLog: (l: string) => void) => Promise<void>, first: string) => {
      setBusy(true);
      setLog([first]);
      try {
        await fn((line) => setLog((l) => [...l, line]));
      } catch (e) {
        setLog((l) => [...l, `✗ ${String(e)}`]);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );
  const start = useCallback(() => run((l) => exegolStart(labId, getAttackImage(), l), "Starting the attack box…"), [run, labId]);
  const stop = useCallback(
    () =>
      run(async (l) => {
        await exegolStop(labId, l);
        // It's gone now: show it immediately (a later poll confirms), so the button flips on
        // the first click instead of waiting on the next status read.
        setStatus((s) => (s ? { ...s, running: false, ip: "" } : s));
      }, "Removing the attack box…"),
    [run, labId],
  );

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!running) {
      autoStarted.current = false;
      return;
    }
    if (!autoStart || !local || !status || status.running || busy || autoStarted.current) return;
    autoStarted.current = true;
    void start();
  }, [running, autoStart, local, status, busy, start]);

  return { status, busy, log, start, stop };
}

export type AttackBox = ReturnType<typeof useAttackBox>;
