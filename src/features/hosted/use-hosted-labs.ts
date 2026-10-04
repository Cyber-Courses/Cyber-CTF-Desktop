"use client";

import { useCallback, useEffect, useState } from "react";
import { apiQuery } from "@/lib/tauri";

export interface HostedLab {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  difficulty: number;
  category: string;
}

export interface HostedEndpoint {
  port: number;
  url: string;
}

/** Mirrors the backend LabSessionState enum. */
export type HostedState = "REQUESTED" | "CLAIMED" | "PULLING" | "RUNNING" | "FAILED" | "STOPPED" | "EXPIRED";

export interface HostedSession {
  id: string;
  state: HostedState;
  endpoints: HostedEndpoint[];
  message: string | null;
  expiresAt: string;
}

// Labs that can run hosted (list the hosted provider + have a prepared snapshot).
const LABS = `{ labs(sort: [{ title: ASC }]) {
  id slug title description difficulty category
  runtime { hosted }
} }`;
const LAUNCH = `mutation ($labId: ID!) {
  requestLabLaunch(labId: $labId, target: "hosted") { id state endpoints { port url } message expiresAt }
}`;
const SESSION = `query ($id: ID!) { labSession(id: $id) { id state endpoints { port url } message expiresAt } }`;
const STOP = `mutation ($id: ID!) { stopLabSession(sessionId: $id) { id state } }`;

const SETTLED: HostedState[] = ["RUNNING", "FAILED", "STOPPED", "EXPIRED"];

type LabRow = HostedLab & { runtime: { hosted: boolean } | null };

/**
 * Hosted labs from CyberBackend: the catalogue that can run on Cyber CTF's own infrastructure
 * (Vercel Sandbox), plus launching one and polling its session to its public endpoints.
 * `available` is false when the deployed backend doesn't expose the hosted API yet, so the
 * screen can fall back to the "coming soon" placeholder.
 */
export function useHostedLabs() {
  const [labs, setLabs] = useState<HostedLab[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [session, setSession] = useState<HostedSession | null>(null);
  const [busyLab, setBusyLab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiQuery<{ labs: LabRow[] }>(LABS)
      .then((d) => {
        setAvailable(true);
        setLabs(
          d.labs
            .filter((l) => l.runtime?.hosted)
            .map((l) => ({ id: l.id, slug: l.slug, title: l.title, description: l.description, difficulty: l.difficulty, category: l.category })),
        );
      })
      .catch((e: unknown) => {
        const msg = String(e);
        // An older deployed schema has no `hosted` field: treat as "not available yet".
        if (/hosted/i.test(msg) && /cannot query|unknown field|field/i.test(msg)) {
          setAvailable(false);
        } else {
          setAvailable(true);
          setError(msg);
        }
        setLabs([]);
      });
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
      // The request returns the REQUESTED session fast; the session card drives the rest.
      setBusyLab(null);
    }
  }, []);

  // Poll the active session until it settles (RUNNING with endpoints, or FAILED/STOPPED/EXPIRED).
  useEffect(() => {
    if (!session || SETTLED.includes(session.state)) return;
    const t = setTimeout(() => {
      apiQuery<{ labSession: HostedSession | null }>(SESSION, { id: session.id })
        .then((d) => {
          if (d.labSession) setSession(d.labSession);
        })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, [session]);

  const stop = useCallback(async () => {
    const current = session;
    setSession(null);
    setBusyLab(null);
    if (current) await apiQuery(STOP, { id: current.id }).catch(() => {});
  }, [session]);

  return { labs, available, session, busyLab, error, launch, stop };
}
