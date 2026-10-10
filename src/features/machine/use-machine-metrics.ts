"use client";

import { useState } from "react";
import { machineMetrics, type MachineMetrics } from "@/lib/tauri";
import { usePoll } from "@/lib/use-poll";
import { appendUsage, type UsageHistory } from "@/features/machine/machine-status";

/**
 * Live machine usage, polled every `ms`, with a rolling history of each figure for the stat
 * card sparklines. `serial`: one read at a time, for a short interval on a busy machine, where a
 * read can take a moment and must not stack on one still running.
 */
export function useMachineMetrics(ms: number, { serial = false }: { serial?: boolean } = {}) {
  const [metrics, setMetrics] = useState<MachineMetrics | null>(null);
  const [history, setHistory] = useState<UsageHistory>({ cpu: [], mem: [], disk: [] });
  usePoll(machineMetrics, ms, {
    serial,
    onValue: (m) => {
      setMetrics(m);
      setHistory((h) => appendUsage(h, m));
    },
  });
  return { metrics, history };
}
