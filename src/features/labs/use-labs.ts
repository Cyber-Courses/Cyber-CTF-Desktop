"use client";

import { useCallback, useEffect, useState } from "react";
import { apiQuery, labStatus, type LabStatus, type Provider, type Runtime } from "@/lib/tauri";

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
export function useLabs(reloadKey: unknown = 0) {
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, LabStatus>>({});
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  const refreshStatus = useCallback((lab: Lab) => {
    if (!lab.runtime) return;
    labStatus(lab.id, lab.runtime.runtime)
      .then((s) => setStatuses((m) => ({ ...m, [lab.id]: s })))
      .catch(() => {
        /* not installed / not running - leave status unknown */
      });
  }, []);

  useEffect(() => {
    apiQuery<{ labs: Lab[] }>(LABS_QUERY)
      .then((d) => {
        setLabs(d.labs);
        setError(null);
        d.labs.forEach(refreshStatus);
      })
      .catch((e) => setError(String(e)));
    // Best effort: logged out (or a backend without the query) just shows no progress.
    apiQuery<{ myCompletedLabs: string[] }>(COMPLETED_QUERY)
      .then((d) => setCompleted(new Set(d.myCompletedLabs)))
      .catch(() => setCompleted(new Set()));
  }, [reloadKey, refreshStatus]);

  // Poll local status so labs launched from the website (claimed + run by the agent)
  // surface here within a few seconds without a manual refresh.
  useEffect(() => {
    if (!labs) return;
    const t = setInterval(() => labs.forEach(refreshStatus), 6000);
    return () => clearInterval(t);
  }, [labs, refreshStatus]);

  return { labs, error, statuses, completed, refreshStatus };
}

export const DIFFICULTY_LABEL = ["", "Easy", "Medium", "Hard"];
export const DIFFICULTY_DOT = ["", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];
