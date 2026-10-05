"use client";

import { useCallback, useEffect, useState } from "react";
import { apiQuery } from "@/lib/tauri";

export interface HostedEndpoint {
  port: number;
  url: string;
}

/** Mirrors the backend LabSessionState enum. */
export type HostedState = "REQUESTED" | "CLAIMED" | "PULLING" | "RUNNING" | "FAILED" | "STOPPED" | "EXPIRED";

export interface HostedSession {
  id: string;
  /** The lab this session runs, so a view can tell whether it's "its" session. */
  labId: string;
  /** "hosted" for a hosted lab; an agent target id, or null, otherwise. */
  target: string | null;
  state: HostedState;
  endpoints: HostedEndpoint[];
  message: string | null;
  expiresAt: string;
}

const FIELDS = "id labId target state endpoints { port url } message expiresAt";
// The player's one active session (any target), so running state shows on Home, the Labs list
// and the lab page across tabs and restarts, not just where it was launched.
const ACTIVE = `query { myActiveLabSession { ${FIELDS} } }`;
const LAUNCH = `mutation ($labId: ID!) { requestLabLaunch(labId: $labId, target: "hosted") { ${FIELDS} } }`;
const SESSION = `query ($id: ID!) { labSession(id: $id) { ${FIELDS} } }`;
const STOP = `mutation ($id: ID!) { stopLabSession(sessionId: $id) { id state } }`;

const SETTLED: HostedState[] = ["RUNNING", "FAILED", "STOPPED", "EXPIRED"];

/**
 * The player's active hosted session: hydrated on mount from `myActiveLabSession` (so it
 * persists across views and restarts), launched with `launch`, polled until it settles, and
 * cleared with `stop`. Only hosted sessions are tracked here; other targets run through the
 * local runtime. Shared by the lab page and Home.
 */
export function useHostedLabs() {
  const [session, setSession] = useState<HostedSession | null>(null);
  const [busyLab, setBusyLab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from the backend once (requires login; a logged-out / errored call just leaves it null).
  useEffect(() => {
    apiQuery<{ myActiveLabSession: HostedSession | null }>(ACTIVE)
      .then((d) => {
        const s = d.myActiveLabSession;
        if (s && s.target === "hosted" && !SETTLED.slice(1).includes(s.state)) setSession(s);
      })
      .catch(() => {});
  }, []);

  const launch = useCallback(async (labId: string) => {
    setBusyLab(labId);
    setError(null);
    try {
      const d = await apiQuery<{ requestLabLaunch: HostedSession }>(LAUNCH, { labId });
      setSession(d.requestLabLaunch);
    } catch (e) {
      setError(String(e));
    } finally {
      // The request returns the REQUESTED session fast; the session state drives the rest.
      setBusyLab(null);
    }
  }, []);

  // Poll the active session until it settles (RUNNING with endpoints, or FAILED/STOPPED/EXPIRED).
  useEffect(() => {
    if (!session || SETTLED.includes(session.state)) return;
    // Cancelled when the session changes (e.g. stop() clears it): a poll already in flight must
    // not resolve afterwards and resurrect a session the user just stopped.
    let cancelled = false;
    const t = setTimeout(() => {
      apiQuery<{ labSession: HostedSession | null }>(SESSION, { id: session.id })
        .then((d) => {
          if (!cancelled && d.labSession) setSession(d.labSession);
        })
        .catch(() => {});
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [session]);

  const stop = useCallback(async () => {
    const current = session;
    setSession(null);
    setBusyLab(null);
    if (current) await apiQuery(STOP, { id: current.id }).catch(() => {});
  }, [session]);

  return { session, busyLab, error, launch, stop };
}
