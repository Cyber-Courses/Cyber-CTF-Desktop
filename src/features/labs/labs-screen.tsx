"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useRequestedLab } from "@/lib/deep-link";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, RailLabel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { LabRow } from "@/features/labs/lab-row";
import { LabDetail } from "@/features/labs/lab-detail";
import { DIFFICULTY_LABEL, useLabs, type Lab } from "@/features/labs/use-labs";
import { useLabActions } from "@/features/labs/use-lab-actions";
import { setupNeeded } from "@/features/labs/lab-readiness";
import { serverList, type ServerHost, type SystemReport } from "@/lib/tauri";
import { getVmProvider } from "@/lib/settings";
import { Segmented } from "@/components/ui/segmented";

type StatusFilter = "all" | "todo" | "running" | "solved";
/** CLOUD = labs that can run in the player's cloud account (AWS is a supported target). */
type RuntimeFilter = "all" | "DOCKER" | "VM" | "CLOUD";

export function Labs({
  loggedIn,
  onLogin,
  hostArch,
  report,
  openLab,
}: {
  loggedIn: boolean;
  /** Logs in from a lab (a logged-out Start). */
  onLogin?: () => Promise<void>;
  hostArch: string;
  report?: SystemReport | null;
  openLab: { slug: string | null; tick: number };
}) {
  const { labs, error, statuses, completed, refreshStatus } = useLabs(loggedIn);
  const { busy, activeLab, logs, times, launch, stop } = useLabActions(refreshStatus);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [runtime, setRuntime] = useState<RuntimeFilter>("all");
  const [difficulty, setDifficulty] = useState(0);
  const [servers, setServers] = useState<ServerHost[]>([]);
  const requested = useRequestedLab();
  // Local hypervisors ready for a lab VM (Vagrant + hypervisor), the Settings default first.
  const readyVms = useMemo(() => {
    const ready = (report?.vagrant.installed ? report.vmProviders : [])
      .filter((p) => !p.remote && p.available && p.hypervisor !== false)
      .map((p) => p.provider);
    const preferred = getVmProvider();
    return preferred && ready.includes(preferred) ? [preferred, ...ready.filter((p) => p !== preferred)] : ready;
  }, [report]);

  // Saved servers count as somewhere a VM lab can run (for the "needs setup" hint).
  useEffect(() => {
    serverList()
      .then((l) => setServers(l.hosts))
      .catch(() => setServers([]));
  }, []);

  // External navigation (sidebar, command palette, Overview): act only when the nav tick
  // changes, so a labs refresh never ejects the user from a detail they opened from the list.
  // A slug opens it (once labs load); no slug returns to the list.
  const lastTick = useRef(-1);
  useEffect(() => {
    if (openLab.tick === lastTick.current) return;
    // A slug that isn't in the catalogue yet: wait (don't consume the tick) until labs load.
    if (openLab.slug && !labs?.some((l) => l.slug === openLab.slug)) return;
    lastTick.current = openLab.tick;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailSlug(openLab.slug);
  }, [openLab, labs]);
  // A deep link (cyberctf://lab/<slug>) opens that lab once the catalogue is loaded.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requested && labs?.some((l) => l.slug === requested)) setDetailSlug(requested);
  }, [requested, labs]);

  const isRunning = (l: Lab) => !!statuses[l.id]?.running;

  const filtered = useMemo(() => {
    if (!labs) return [];
    const q = query.trim().toLowerCase();
    return labs.filter((l) => {
      if (q && !`${l.title} ${l.category} ${l.description ?? ""} ${(l.skills ?? []).map((s) => s.name).join(" ")}`.toLowerCase().includes(q)) return false;
      if (runtime === "CLOUD" ? !l.runtime?.providers.includes("aws") : runtime !== "all" && l.runtime?.runtime !== runtime) return false;
      if (difficulty && l.difficulty !== difficulty) return false;
      const running = !!statuses[l.id]?.running;
      if (status === "running" && !running) return false;
      if (status === "solved" && !completed.has(l.id)) return false;
      if (status === "todo" && (completed.has(l.id) || running)) return false;
      return true;
    });
  }, [labs, query, runtime, difficulty, status, statuses, completed]);

  // Running labs are pinned on top; the rest follow in one list, by title.
  const running = filtered.filter(isRunning);
  const rest = useMemo(
    () => filtered.filter((l) => !statuses[l.id]?.running).sort((a, b) => a.title.localeCompare(b.title)),
    [filtered, statuses],
  );

  if (error) return <EmptyState icon="alert" title="Can’t reach the lab catalogue" description="Check your connection or sign in, then try again." />;

  const detail = labs && detailSlug ? labs.find((l) => l.slug === detailSlug) : undefined;
  if (detail) {
    return (
      <LabDetail
        lab={detail}
        status={statuses[detail.id]}
        busy={busy === detail.id}
        logs={activeLab === detail.id ? logs : []}
        times={activeLab === detail.id ? times : []}
        loggedIn={loggedIn}
        onLogin={onLogin}
        hostArch={hostArch}
        onBack={() => setDetailSlug(null)}
        readyVms={readyVms}
        dockerRunning={report ? report.dockerRunning : null}
        onStart={(t) => launch(detail, t.kind === "host" ? t.id : null, t.kind === "local-vm" ? t.provider : undefined)}
        onStop={() => stop(detail)}
      />
    );
  }

  const row = (lab: Lab) => (
    <LabRow
      key={lab.id}
      lab={lab}
      status={statuses[lab.id]}
      busy={busy === lab.id}
      loggedIn={loggedIn}
      onLogin={onLogin}
      hostArch={hostArch}
      solved={completed.has(lab.id)}
      setup={isRunning(lab) ? null : setupNeeded(lab, report ?? null, servers)}
      onOpen={() => setDetailSlug(lab.slug)}
      onStop={() => stop(lab)}
    />
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
          <input
            data-lab-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search labs and skills…"
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-[0.8125rem] outline-none placeholder:text-muted-foreground/60 focus:border-ring/60"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<StatusFilter>
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All" },
              { value: "todo", label: "To do" },
              { value: "running", label: "Running" },
              { value: "solved", label: "Solved" },
            ]}
          />
          <Segmented<RuntimeFilter>
            label="Runtime"
            value={runtime}
            onChange={setRuntime}
            options={[
              { value: "all", label: "Any runtime" },
              { value: "DOCKER", label: "Container" },
              { value: "VM", label: "VM" },
              { value: "CLOUD", label: "Cloud" },
            ]}
          />
          <Segmented<number>
            label="Level"
            value={difficulty}
            onChange={setDifficulty}
            options={[{ value: 0, label: "Any level" }, ...[1, 2, 3].map((d) => ({ value: d, label: DIFFICULTY_LABEL[d] }))]}
          />
          {labs && labs.length > 0 && (
            <span className="ml-auto text-[0.75rem] tabular-nums text-muted-foreground">
              {labs.filter((l) => completed.has(l.id)).length} of {labs.length} solved
            </span>
          )}
        </div>
      </div>

      {!labs ? (
        <Panel>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
              <Skeleton className="size-[1.875rem] rounded-lg" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="mt-2 h-2.5 w-24" />
              </div>
              <Skeleton className="h-6 w-16 rounded-md" />
            </div>
          ))}
        </Panel>
      ) : labs.length === 0 ? (
        <EmptyState icon="labs" title="No labs published yet" description="Published labs will show up here, ready to run on this machine." />
      ) : filtered.length === 0 ? (
        <EmptyState icon="labs" title="No labs match" description="Nothing matches these filters. Try another search or clear a filter." />
      ) : (
        <>
          {running.length > 0 && (
            <section>
              <RailLabel>Running now</RailLabel>
              <Panel>{running.map(row)}</Panel>
            </section>
          )}
          {rest.length > 0 && (
            <section>
              {running.length > 0 && <RailLabel>All labs</RailLabel>}
              <Panel>{rest.map(row)}</Panel>
            </section>
          )}
        </>
      )}
    </div>
  );
}
