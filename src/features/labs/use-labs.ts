"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiQuery, labStatus, runningLabs, type LabStatus, type Provider, type Runtime } from "@/lib/tauri";

export interface LabRuntimeInfo {
  runtime: Runtime;
  architectures: string[];
  providers: Provider[];
  /** Cyber CTF can run it for the player (hosted provider + a prepared snapshot). */
  hosted?: boolean;
}

export interface Lab {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  question: string | null;
  difficulty: number;
  category: string;
  runtime: LabRuntimeInfo | null;
  /** Skills the lab exercises (from the capabilities it targets), for grouping. */
  skills: { id: string; name: string }[];
}

const LABS_QUERY = `{ labs(sort: [{ title: ASC }]) {
  id slug title description question difficulty category
  runtime { runtime architectures providers hosted }
  skills { id name }
} }`;

/** The labs this player has solved (correct evidence submitted on the website). */
const COMPLETED_QUERY = `{ myCompletedLabs }`;

/**
 * Loads the published labs from CyberBackend and tracks each lab's local runtime status
 * (running / machines / url). Shared by the Labs screen and the Home dashboard so both
 * reflect the same state. `reloadKey` re-fetches the catalogue when it changes.
 */
// The last statuses read, kept across screens: a lab page opened again renders at once from them
// (refreshed right away) instead of waiting on a fresh probe, which takes seconds on a busy machine.
let lastStatuses: Record<string, LabStatus> = {};
let lastProbed = new Set<string>();
// The catalogue last loaded, for the same reloadKey (sign-in state): shown while it reloads.
let lastCatalogue: { key: unknown; labs: Lab[] } | null = null;

export function useLabs(reloadKey: unknown = 0) {
  const [labs, setLabs] = useState<Lab[] | null>(() => {
    const cached = lastCatalogue;
    return cached && cached.key === reloadKey ? cached.labs : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatusesState] = useState<Record<string, LabStatus>>(lastStatuses);
  const setStatuses = useCallback((f: (m: Record<string, LabStatus>) => Record<string, LabStatus>) => {
    setStatusesState((m) => (lastStatuses = f(m)));
  }, []);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  // Labs the infrastructure scan (docker/vagrant) reports running. Authoritative for the running
  // flag: a lab is shown running when the scan sees it even if its per-lab status probe is failing
  // or hasn't run yet (e.g. right after a crash/restart).
  const [scanRunning, setScanRunning] = useState<Set<string>>(new Set());
  // Labs whose status has been asked at least once (answered or not): a page can wait for its
  // first answer instead of rendering a "not started" lab that flips to running a beat later.
  const [probed, setProbedState] = useState<Set<string>>(lastProbed);
  const setProbed = useCallback((f: (p: Set<string>) => Set<string>) => {
    setProbedState((p) => (lastProbed = f(p)));
  }, []);

  // One status read per lab at a time: a slow read (a busy VirtualBox can take seconds) must not
  // let the poll interval stack a second, third, … read on top of it; a poll joins the read in
  // flight. A `fresh` read (right after an operation) always starts, and only the newest read of
  // a lab may set its status: a poll that began before a shutdown ended must not land after it
  // with the old "running" and bring back the running lab's buttons.
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());
  const latest = useRef<Map<string, number>>(new Map());
  // When each lab's latest fresh read began: an infrastructure scan begun before it is older news
  // for that lab, and must not keep it "running" (see the scan below).
  const freshAt = useRef<Map<string, number>>(new Map());
  const refreshStatus = useCallback(
    (lab: Lab, { fresh = false }: { fresh?: boolean } = {}): Promise<void> => {
      if (!lab.runtime) return Promise.resolve();
      const pending = inFlight.current.get(lab.id);
      if (pending && !fresh) return pending;
      const mine = (latest.current.get(lab.id) ?? 0) + 1;
      latest.current.set(lab.id, mine);
      if (fresh) freshAt.current.set(lab.id, Date.now());
      const read: Promise<void> = labStatus(lab.id, lab.runtime.runtime)
        .then((s) => {
          if (latest.current.get(lab.id) !== mine) return;
          setStatuses((m) => ({ ...m, [lab.id]: s }));
          // Down now: the last scan's "running" for it is out of date.
          if (fresh && !s.running) setScanRunning((r) => (r.has(lab.id) ? new Set([...r].filter((id) => id !== lab.id)) : r));
        })
        .catch(() => {
          /* not installed / not running - leave status unknown */
        })
        .finally(() => {
          if (inFlight.current.get(lab.id) === read) inFlight.current.delete(lab.id);
          setProbed((p) => (p.has(lab.id) ? p : new Set(p).add(lab.id)));
        });
      inFlight.current.set(lab.id, read);
      return read;
    },
    [setStatuses, setProbed],
  );

  useEffect(() => {
    // Cancelled when reloadKey changes (e.g. login toggles): a response in flight from the
    // previous key must not resolve last and overwrite the newer catalogue.
    let alive = true;
    apiQuery<{ labs: Lab[] }>(LABS_QUERY)
      .then((d) => {
        if (!alive) return;
        lastCatalogue = { key: reloadKey, labs: d.labs };
        setLabs(d.labs);
        setError(null);
        d.labs.forEach((l) => void refreshStatus(l));
      })
      .catch((e) => alive && setError(String(e)));
    // Best effort: logged out (or a backend without the query) just shows no progress.
    apiQuery<{ myCompletedLabs: string[] }>(COMPLETED_QUERY)
      .then((d) => alive && setCompleted(new Set(d.myCompletedLabs)))
      .catch(() => alive && setCompleted(new Set()));
    return () => {
      alive = false;
    };
  }, [reloadKey, refreshStatus]);

  // Poll local status so labs launched from the website (claimed + run by the agent)
  // surface here within a few seconds without a manual refresh.
  useEffect(() => {
    if (!labs) return;
    const t = setInterval(() => labs.forEach((l) => void refreshStatus(l)), 6000);
    return () => clearInterval(t);
  }, [labs, refreshStatus]);

  // Reconcile what is actually running from the infrastructure itself (docker + vagrant), so a
  // running lab is detected after a crash/restart, and a successful launch never falls back to a
  // "Start lab" page just because its per-lab status probe briefly fails. The scan is ground
  // truth; refreshStatus then fills in each running lab's machines and URL.
  useEffect(() => {
    let alive = true;
    const scan = () => {
      const began = Date.now();
      return runningLabs()
        .then((all) => {
          if (!alive) return;
          // A lab read fresh after this scan began (an operation just ended on it) is left out.
          const ids = all.filter((id) => (freshAt.current.get(id) ?? 0) < began);
          setScanRunning(new Set(ids));
          (labs ?? []).filter((l) => ids.includes(l.id)).forEach((l) => void refreshStatus(l));
        })
        .catch(() => {});
    };
    scan();
    const t = setInterval(scan, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [labs, refreshStatus]);

  // The scan is authoritative for "running": OR it over each lab's probed status, so a lab the
  // scan sees stays running even when its per-lab probe returns not-running or errors. A lab the
  // scan does not see keeps its probed status (remote labs, stopped labs).
  const mergedStatuses = useMemo(() => {
    if (scanRunning.size === 0) return statuses;
    const next: Record<string, LabStatus> = { ...statuses };
    for (const id of scanRunning) {
      const cur = next[id];
      next[id] = cur
        ? { ...cur, running: true }
        : { running: true, parked: null, machines: [], networks: [], url: null, host: null, expiresAt: null, place: null, provider: null };
    }
    return next;
  }, [statuses, scanRunning]);

  return { labs, error, statuses: mergedStatuses, completed, refreshStatus, probed };
}

export const DIFFICULTY_LABEL = ["", "Easy", "Medium", "Hard"];
export const DIFFICULTY_DOT = ["", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];
