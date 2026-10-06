"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { deployingLabs, labDeployLog, stoppingLabs } from "@/lib/tauri";

/**
 * The live state of lab start/stop, kept outside the React tree so it survives navigating
 * away from the labs screen (which unmounts it) while a deploy keeps running in the backend.
 * `useLabActions` writes here; any screen reads the same snapshot and sees the in-progress
 * logs and which lab is busy when it mounts.
 */
/** One lab's live run. Kept per lab so two deploys at once don't share a log stream. */
export type DeployRun = {
  /** Whether this lab is currently starting or stopping. */
  busy: boolean;
  /** The streamed log lines of this lab's current run. */
  logs: string[];
  /** The arrival time (ms) of each log line, parallel to `logs`, so step timings survive
   *  leaving and returning to the lab page. */
  times: number[];
};
/** Every lab with a run in flight or just finished, keyed by lab id. A single global slot
 *  would cross-contaminate: with two deploys running, the second's lines would appear on the
 *  first's page. Keying by lab id keeps each lab's log stream its own. */
export type DeployState = { runs: Record<string, DeployRun> };

const EMPTY_RUN: DeployRun = { busy: false, logs: [], times: [] };

let state: DeployState = { runs: {} };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setRun(labId: string, run: DeployRun) {
  state = { runs: { ...state.runs, [labId]: run } };
  emit();
}

/** Begin a run for `labId`: clears that lab's previous logs, leaves other labs untouched. */
export function beginDeploy(labId: string) {
  setRun(labId, { busy: true, logs: [], times: [] });
}

/** Append a log line to `labId`'s run, timestamped on arrival. */
export function appendDeployLog(labId: string, line: string) {
  const prev = state.runs[labId] ?? EMPTY_RUN;
  setRun(labId, { ...prev, busy: true, logs: [...prev.logs, line], times: [...prev.times, Date.now()] });
}

/** End `labId`'s run (keeps its logs so the console stays readable). */
export function endDeploy(labId: string) {
  const prev = state.runs[labId];
  if (!prev) return;
  setRun(labId, { ...prev, busy: false });
}

/** Subscribe to store changes; returns an unsubscribe. Exposed so the store can be driven and
 *  asserted in tests without rendering React. */
export function subscribeDeploy(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The current state, for `useSyncExternalStore` and for tests. */
export function getDeploySnapshot(): DeployState {
  return state;
}

export function useDeploy(): DeployState {
  return useSyncExternalStore(subscribeDeploy, getDeploySnapshot, getDeploySnapshot);
}

/** This lab's run, or an empty one, so callers can read `logs`/`times`/`busy` unconditionally. */
export function useDeployRun(labId: string): DeployRun {
  return useDeploy().runs[labId] ?? EMPTY_RUN;
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

/**
 * The lab ids the backend is stopping right now (a teardown in flight), polled like
 * `useDeployingLabs`, so a lab being stopped reads "Stopping", never "Deploying".
 */
export function useStoppingLabs(pollMs = 4000): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const read = () =>
      stoppingLabs()
        .then((l) => alive && setIds(new Set(l)))
        .catch(() => {});
    read();
    const t = setInterval(read, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return ids;
}

/**
 * The log of a lab's deploy running in its detached worker process, followed while `active`.
 * For a page that (re)attaches to a deploy after a reload or an app relaunch: the in-memory
 * store has no lines of it, the worker's log file has them all.
 */
export function useWorkerLog(labId: string, active: boolean, pollMs = 1500): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = () =>
      labDeployLog(labId)
        .then((text) => alive && setLines(text.split("\n").filter((l) => l.length > 0)))
        .catch(() => {});
    read();
    const t = setInterval(read, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [labId, active, pollMs]);
  return lines;
}
