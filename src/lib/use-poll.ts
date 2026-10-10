"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ignore } from "@/lib/failure";

export interface PollOptions<T> {
  /** Each answer, unless the poll stopped or restarted while it was being read. */
  onValue: (value: T) => void;
  /** A failed read; by default ignored, since the next tick reads again. */
  onError?: (e: unknown) => void;
  /** Skip a tick while the previous read is still in flight: slow reads must not stack. */
  serial?: boolean;
  /** Also read when the window regains focus. */
  onFocus?: boolean;
  /** False pauses the poll. */
  enabled?: boolean;
  /** A change restarts the poll, with an immediate read. */
  restartKey?: unknown;
}

const IGNORE = ignore("polled again in a moment");

/**
 * Reads `read()` now and then every `ms` while enabled. The latest `read` and callbacks are used
 * on each tick without restarting the poll. Returns a function that reads once more right away.
 */
export function usePoll<T>(
  read: () => Promise<T>,
  ms: number,
  { onValue, onError, serial = false, onFocus = false, enabled = true, restartKey }: PollOptions<T>,
) {
  const latest = useRef({ read, onValue, onError });
  useEffect(() => {
    latest.current = { read, onValue, onError };
  });
  const now = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let reading = false;
    const tick = () => {
      if (serial && reading) return;
      reading = true;
      latest.current
        .read()
        .then(
          (v) => alive && latest.current.onValue(v),
          (e) => alive && (latest.current.onError ?? IGNORE)(e),
        )
        .finally(() => {
          reading = false;
        });
    };
    now.current = tick;
    tick();
    const timer = setInterval(tick, ms);
    if (onFocus) window.addEventListener("focus", tick);
    return () => {
      alive = false;
      now.current = () => {};
      clearInterval(timer);
      if (onFocus) window.removeEventListener("focus", tick);
    };
  }, [ms, serial, onFocus, enabled, restartKey]);

  return useCallback(() => now.current(), []);
}

/** `usePoll` keeping the latest answer as state: `[value, readNow]`. */
export function usePolled<T>(read: () => Promise<T>, ms: number, initial: T, options: Omit<PollOptions<T>, "onValue"> = {}) {
  const [value, setValue] = useState<T>(initial);
  const readNow = usePoll(read, ms, { ...options, onValue: setValue });
  return [value, readNow] as const;
}
