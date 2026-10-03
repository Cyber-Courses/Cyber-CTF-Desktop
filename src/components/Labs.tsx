"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useRequestedLab } from "@/lib/deep-link";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { LabRow } from "@/components/labs/lab-row";
import { LabDetail } from "@/components/labs/lab-detail";
import { useLabs } from "@/lib/use-labs";
import { useLabActions } from "@/lib/use-lab-actions";

export function Labs({ loggedIn, hostArch, openSlug }: { loggedIn: boolean; hostArch: string; openSlug?: string | null }) {
  const { labs, error, statuses, refreshStatus } = useLabs(loggedIn);
  const { busy, activeLab, logs, launch, stop } = useLabActions(refreshStatus);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const requested = useRequestedLab();

  // Open a lab's detail from a deep link or from another screen (Overview).
  useEffect(() => {
    const slug = openSlug || requested;
    if (slug && labs?.some((l) => l.slug === slug)) setDetailSlug(slug);
  }, [openSlug, requested, labs]);

  const filtered = useMemo(() => {
    if (!labs) return [];
    const q = query.trim().toLowerCase();
    if (!q) return labs;
    return labs.filter((l) => `${l.title} ${l.category} ${l.description ?? ""}`.toLowerCase().includes(q));
  }, [labs, query]);

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
        onStart={() => launch(detail)}
        onStop={() => stop(detail)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search labs…"
          className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-ring/60"
        />
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
        <EmptyState icon="labs" title="No labs match" description={`Nothing for “${query}”. Try another search.`} />
      ) : (
        <Panel>
          {filtered.map((lab) => (
            <LabRow
              key={lab.id}
              lab={lab}
              status={statuses[lab.id]}
              busy={busy === lab.id}
              loggedIn={loggedIn}
              hostArch={hostArch}
              onOpen={() => setDetailSlug(lab.slug)}
              onStart={() => launch(lab)}
              onStop={() => stop(lab)}
            />
          ))}
        </Panel>
      )}
    </div>
  );
}
