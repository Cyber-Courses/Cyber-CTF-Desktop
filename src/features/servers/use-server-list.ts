"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SERVER_CHANGED, serverList, serverTest, type ServerList, type ServerTest } from "@/lib/tauri";
import { useTauriEvent } from "@/lib/use-tauri-event";

/** A test that couldn't run, in the shape of one that failed (the row shows why). */
export const failedTest = (e: unknown): ServerTest => ({ ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e), checks: [] });

/** Tests a server or cloud account; never rejects (a failure to test reads as a failed test). */
export const testHost = (id: string) => serverTest(id).catch(failedTest);

/**
 * The saved servers and cloud accounts, read on mount, again with `reload()`, and whenever the
 * setup window says one changed (`onChanged` first). `onLoaded` sees each list read.
 */
export function useServerList({ onLoaded, onChanged }: { onLoaded?: (list: ServerList) => void; onChanged?: () => void } = {}) {
  const [list, setList] = useState<ServerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(onLoaded);
  useEffect(() => {
    loaded.current = onLoaded;
  });
  const reload = useCallback(() => {
    serverList()
      .then((l) => {
        setList(l);
        setError(null);
        loaded.current?.(l);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);
  // The setup window saves hosts; refresh when it says so.
  useTauriEvent(SERVER_CHANGED, () => {
    onChanged?.();
    reload();
  });
  return { list, error, setError, reload };
}

/** The last test of each host ("testing" while one runs), and `test(id)` to run one. */
export function useHostTests() {
  const [tests, setTests] = useState<Record<string, ServerTest | "testing">>({});
  const test = useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    const r = await testHost(id);
    setTests((t) => ({ ...t, [id]: r }));
  }, []);
  return { tests, test };
}
