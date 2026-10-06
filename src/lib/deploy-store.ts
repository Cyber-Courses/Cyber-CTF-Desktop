"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { deployingLabs } from "@/lib/tauri";

/**
 * The live state of lab start/stop, kept outside the React tree so it survives navigating
 * away from the labs screen (which unmounts it) while a deploy keeps running in the backend.
 * `useLabActions` writes here; any screen reads the same snapshot and sees the in-progress
 * logs and which lab is busy when it mounts.
 */
export type DeployState = {
  /** The lab id currently starting or stopping, or null. */
  busy: string | null;
  /** The lab whose logs `logs` holds (the last one acted on). */
  activeLab: string | null;
  /** The streamed log lines of `activeLab`. */
  logs: string[];
  /** The arrival time (ms) of each log line, parallel to `logs`. Kept here (not in the
   *  component) so the deploy step timings survive leaving and returning to the lab page. */
  times: number[];
};

let state: DeployState = { busy: null, activeLab: null, logs: [], times: [] };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Replace the state (a new object, so useSyncExternalStore re-renders). */
export function setDeploy(next: Partial<DeployState>) {
  state = { ...state, ...next };
  emit();
}

/** Begin a run for `labId`: clears the previous logs. */
export function beginDeploy(labId: string) {
  state = { busy: labId, activeLab: labId, logs: [], times: [] };
  emit();
}

/** Append a log line for the active run, timestamped on arrival. */
export function appendDeployLog(line: string) {
  state = { ...state, logs: [...state.logs, line], times: [...state.times, Date.now()] };
  emit();
}

/** End the current run (keeps the logs so the console stays readable). */
export function endDeploy() {
  state = { ...state, busy: null };
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDeploy(): DeployState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/**
 * The lab ids the backend is starting or stopping right now, polled from the long-lived Rust
 * process. The in-memory store above is lost when the window reloads (a dev rebuild, a crash, or
 * fast-refresh), but the deploy keeps running; reading this lets a screen show "this lab is
 * starting" again instead of a bare Start button (which would invite a colliding second start).
 */
export function useDeployingLabs(pollMs = 4000): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const read = () =>
      deployingLabs()
        .then((l) => alive && setIds(new Set(l)))
        .catch(() => {});
    read();
    const t = setInterval(read, pollMs);
    const onFocus = () => read();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [pollMs]);
  return ids;
}
