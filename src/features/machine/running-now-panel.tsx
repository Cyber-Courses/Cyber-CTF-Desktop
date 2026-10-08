"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Container, Server, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { TypeIcon } from "@/components/ui/type-icon";
import { PROVIDER_LABELS } from "@/features/machine/hypervisors";
import { ListSkeleton } from "@/features/machine/machine-parts";
import { formatBytes } from "@/lib/format";
import { apiQuery, machineWorkloadStop, machineWorkloads, type Workload } from "@/lib/tauri";
import { ignore } from "@/lib/failure";

/** What's running on this machine (Docker and Vagrant), with a Stop per lab. Polled every 8s,
 *  and again whenever `refreshKey` changes (e.g. after a setup test). */
export function RunningNowPanel({ refreshKey }: { refreshKey: unknown }) {
  const [workloads, setWorkloads] = useState<Workload[] | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  // One workloads read at a time: the read shells out to docker/vagrant and can be slow, so the
  // 8s poll must not stack reads on top of one still in flight.
  const loading = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const load = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    machineWorkloads()
      .then((w) => alive.current && setWorkloads(w))
      .catch(() => alive.current && setWorkloads([]))
      .finally(() => {
        loading.current = false;
      });
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load, refreshKey]);

  // Lab titles for the list (the runtime only knows ids).
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    apiQuery<{ labs: { id: string; title: string }[] }>("{ labs { id title } }")
      .then((d) => setTitles(Object.fromEntries(d.labs.map((l) => [l.id, l.title]))))
      .catch(ignore("lab ids are shown instead of titles"));
  }, []);

  async function stop(w: Workload) {
    setStopping(`${w.kind}:${w.id}`);
    try {
      await machineWorkloadStop(w.kind, w.id);
    } catch {
      /* the list shows what's still running */
    } finally {
      setStopping(null);
      load();
    }
  }

  const labMem = (workloads ?? []).reduce((a, w) => a + w.memBytes, 0);
  return (
    <Panel>
      <PanelHeader title="Running now" meta={labMem > 0 ? <span className="tabular-nums">{formatBytes(labMem)} in use</span> : undefined} />
      {workloads === null ? (
        <ListSkeleton />
      ) : workloads.length === 0 ? (
        <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">Nothing running.</p>
      ) : (
        workloads.map((w) => {
          const key = `${w.kind}:${w.id}`;
          const name = w.id === "selftest" ? "Setup test" : (titles[w.id] ?? w.id);
          const meta =
            w.kind === "docker"
              ? `${w.count} container${w.count === 1 ? "" : "s"}${w.memBytes ? ` · ${formatBytes(w.memBytes)}` : ""}`
              : `${w.count} VM${w.count === 1 ? "" : "s"}${w.provider ? ` · ${PROVIDER_LABELS[w.provider] ?? w.provider}` : ""}`;
          return (
            <div
              key={key}
              className="flex min-h-[3.25rem] items-center gap-3 border-t border-border px-4 py-2 transition-colors first:border-t-0 hover:bg-glass"
            >
              <TypeIcon>{w.kind === "docker" ? <Container className="size-4" /> : <Server className="size-4" />}</TypeIcon>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] font-medium text-foreground">{name}</p>
                <p className="truncate font-mono text-[0.6875rem] tabular-nums text-faint">{meta}</p>
              </div>
              <Button variant="outline" size="xs" onClick={() => stop(w)} disabled={stopping !== null}>
                {stopping === key ? (
                  <>
                    <Spinner className="size-3" /> Stopping…
                  </>
                ) : (
                  <>
                    <Square className="size-3" /> Stop
                  </>
                )}
              </Button>
            </div>
          );
        })
      )}
    </Panel>
  );
}
