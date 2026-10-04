"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useRequestedLab } from "@/lib/deep-link";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, RailLabel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { LabRow } from "@/components/labs/lab-row";
import { LabDetail } from "@/components/labs/lab-detail";
import { DIFFICULTY_LABEL, useLabs, type Lab } from "@/lib/use-labs";
import { useLabActions } from "@/lib/use-lab-actions";
import { setupNeeded } from "@/lib/lab-readiness";
import { serverList, type ServerHost, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "todo" | "running" | "solved";
/** CLOUD = labs that can run in the player's cloud account (AWS is a supported target). */
type RuntimeFilter = "all" | "DOCKER" | "VM" | "CLOUD";

/** The skill a lab is listed under: its first skill by name, else its category. */
function groupOf(lab: Lab): string {
  const skill = [...(lab.skills ?? [])].sort((a, b) => a.name.localeCompare(b.name))[0];
  return skill?.name ?? lab.category.charAt(0) + lab.category.slice(1).toLowerCase();
}

/** A row of mutually exclusive filter chips. */
function Chips<T extends string | number>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-[0.75rem] transition-colors",
            value === o.value ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Labs({
  loggedIn,
  hostArch,
  report,
  openSlug,
}: {
  loggedIn: boolean;
  hostArch: string;
  report?: SystemReport | null;
  openSlug?: string | null;
}) {
  const { labs, error, statuses, completed, refreshStatus } = useLabs(loggedIn);
  const { busy, activeLab, logs, launch, stop } = useLabActions(refreshStatus);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [runtime, setRuntime] = useState<RuntimeFilter>("all");
  const [difficulty, setDifficulty] = useState(0);
  const [servers, setServers] = useState<ServerHost[]>([]);
  const requested = useRequestedLab();

  // Saved servers count as somewhere a VM lab can run (for the "needs setup" hint).
  useEffect(() => {
    serverList()
      .then((l) => setServers(l.hosts))
      .catch(() => setServers([]));
  }, []);

  // Open a lab's detail from a deep link or from another screen (Overview).
  useEffect(() => {
    const slug = openSlug || requested;
    // Syncs an external request (deep link, Overview) into local navigation state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (slug && labs?.some((l) => l.slug === slug)) setDetailSlug(slug);
  }, [openSlug, requested, labs]);

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

  // Running labs are pinned on top; the rest are grouped by skill.
  const running = filtered.filter(isRunning);
  const groups = useMemo(() => {
    const m = new Map<string, Lab[]>();
    filtered.filter((l) => !statuses[l.id]?.running).forEach((l) => m.set(groupOf(l), [...(m.get(groupOf(l)) ?? []), l]));
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, statuses]);

  if (error) return <EmptyState icon="alert" title="Can’t reach the lab catalogue" description="Check your connection or sign in, then try again." />;

  const detail = labs && detailSlug ? labs.find((l) => l.slug === detailSlug) : undefined;
  if (detail) {
    return (
      <LabDetail
        lab={detail}
        status={statuses[detail.id]}
        busy={busy === detail.id}
        logs={activeLab === detail.id ? logs : []}
        loggedIn={loggedIn}
        hostArch={hostArch}
        onBack={() => setDetailSlug(null)}
        onStart={(host) => launch(detail, host)}
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
      hostArch={hostArch}
      solved={completed.has(lab.id)}
      setup={isRunning(lab) ? null : setupNeeded(lab, report ?? null, servers)}
      onOpen={() => setDetailSlug(lab.slug)}
      onStart={() => launch(lab)}
      onStop={() => stop(lab)}
    />
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search labs and skills…"
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-[0.8125rem] outline-none placeholder:text-muted-foreground/60 focus:border-ring/60"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All" },
              { value: "todo", label: "To do" },
              { value: "running", label: "Running" },
              { value: "solved", label: "Solved" },
            ]}
          />
          <Chips<RuntimeFilter>
            value={runtime}
            onChange={setRuntime}
            options={[
              { value: "all", label: "Any runtime" },
              { value: "DOCKER", label: "Container" },
              { value: "VM", label: "VM" },
              { value: "CLOUD", label: "Cloud" },
            ]}
          />
          <Chips<number>
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
              <Skeleton className="size-[30px] rounded-lg" />
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
          {groups.map(([group, list]) => (
            <section key={group}>
              <RailLabel right={<span className="text-[0.75rem] tabular-nums text-muted-foreground">{list.length}</span>}>{group}</RailLabel>
              <Panel>{list.map(row)}</Panel>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
