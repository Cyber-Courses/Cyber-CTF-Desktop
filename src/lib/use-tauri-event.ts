"use client";

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { ignore } from "@/lib/failure";

/**
 * Calls `handler` with the payload of each Tauri `event` while mounted and `enabled`. The latest
 * `handler` is used without listening again.
 */
export function useTauriEvent<T = unknown>(event: string, handler: (payload: T) => void, enabled = true) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const off = listen<T>(event, (e) => latest.current(e.payload));
    return () => {
      off.then((f) => f()).catch(ignore("the listener was never set up"));
    };
  }, [event, enabled]);
}
