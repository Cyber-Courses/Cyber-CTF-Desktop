"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { attackVmStart, attackVmStatus, attackVmStop, exegolStart, exegolStatus, exegolStop, type ExegolStatus } from "@/lib/tauri";
import { getAttackBox, getAttackImage, getAutoAttackBox } from "@/lib/settings";

/** What the attack box is: a container on a container lab's networks, or the learner's own VM
 *  (a Vagrant box) beside a VM lab, on the same hypervisor. */
export type AttackBoxKind = "container" | "vm";

/**
 * The lab's attack box: polled while a lab is up on this machine (so running / IP stay
 * current), started and stopped with a streamed log, and started with the lab when the
 * Settings preference is on (once per run). `kind` picks the container (image from Settings)
 * or the VM (box from Settings); both report the same status shape.
 */
export function useAttackBox(labId: string, { running, local, kind = "container" }: { running: boolean; local: boolean; kind?: AttackBoxKind }) {
  const [status, setStatus] = useState<ExegolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  // Set in Settings; read once per visit.
  const [autoStart] = useState(() => getAutoAttackBox());
  // The image or box in use, for the panel's label.
  const name = kind === "vm" ? getAttackBox() : getAttackImage();

  // Only the newest status read wins: a slow poll that was already in flight when the box was
  // stopped must not resolve afterwards with a stale "running" and flip the button back (which
  // made Stop seem to need two or three clicks).
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    (kind === "vm" ? attackVmStatus(labId, getAttackBox()) : exegolStatus(labId, getAttackImage()))
      .then((s) => {
        if (mine === seq.current) setStatus(s);
      })
      .catch(() => {
        if (mine === seq.current) setStatus(null);
      });
  }, [labId, kind]);
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
  const start = useCallback(
    () =>
      run(
        (l) => (kind === "vm" ? attackVmStart(labId, getAttackBox(), l) : exegolStart(labId, getAttackImage(), l)),
        kind === "vm" ? "Starting the attack VM…" : "Starting the attack box…",
      ),
    [run, labId, kind],
  );
  const stop = useCallback(
    () =>
      run(async (l) => {
        await (kind === "vm" ? attackVmStop(labId, l) : exegolStop(labId, l));
        // It's gone now: show it immediately (a later poll confirms), so the button flips on
        // the first click instead of waiting on the next status read.
        setStatus((s) => (s ? { ...s, running: false, ip: "" } : s));
      }, "Removing the attack box…"),
    [run, labId, kind],
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

  return { status, busy, log, start, stop, kind, name };
}

export type AttackBox = ReturnType<typeof useAttackBox>;
