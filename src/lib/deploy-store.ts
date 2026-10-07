"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { activeOperations, deployingLabs, labDeployLog, parkingLabs, stoppingLabs, type ActiveOperation } from "@/lib/tauri";

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
  noteSignedOut(line);
  const prev = state.runs[labId] ?? EMPTY_RUN;
  setRun(labId, { ...prev, busy: true, logs: [...prev.logs, line], times: [...prev.times, Date.now()] });
}

/** Fired when an action failed because the session is gone; the shell re-reads the sign-in. */
export const SIGNED_OUT_EVENT = "cyberctf:signed-out";

/** The backend's "You're signed out…" / "…session expired…" errors (account/auth.rs). */
export function noteSignedOut(text: string) {
  if (typeof window !== "undefined" && /\bsigned out\b/i.test(text)) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
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
  return usePolledIds(stoppingLabs, pollMs);
}

/** The lab ids being paused or shut down right now (machines kept), so the sidebar says so. */
export function useParkingLabs(pollMs = 4000): Set<string> {
  return usePolledIds(parkingLabs, pollMs);
}

/** The sidebar's label for an operation, e.g. "Pausing…"; the machine when it targets one. */
export function operationLabel(o: ActiveOperation): string {
  switch (o.op) {
    case "launch":
      return "Deploying…";
    case "resume":
      return "Resuming…";
    case "pause":
      return "Pausing…";
    case "shutdown":
      return "Shutting down…";
    case "provision":
      return o.machine ? `Provisioning ${o.machine.replace(/^isoloom-/, "")}…` : "Provisioning…";
    case "attack_vm":
      return "Starting the attack VM…";
    case "stop":
      return "Stopping…";
  }
}

/**
 * Every operation in flight, by lab, with the step its log is at. Polled often (steps move
 * every few seconds during a VM start), so the sidebar reads like a live progress line.
 */
export function useActiveOperations(pollMs = 2000): Map<string, ActiveOperation> {
  const [ops, setOps] = useState<Map<string, ActiveOperation>>(new Map());
  useEffect(() => {
    let alive = true;
    const tick = () =>
      activeOperations()
        .then((l) => alive && setOps(new Map(l.map((o) => [o.labId, o]))))
        .catch(() => {});
    tick();
    const t = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return ops;
}

function usePolledIds(read: () => Promise<string[]>, pollMs: number): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const tick = () =>
      read()
        .then((l) => alive && setIds(new Set(l)))
        .catch(() => {});
    tick();
    const t = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [read, pollMs]);
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
