"use client";

import { useSyncExternalStore } from "react";

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
