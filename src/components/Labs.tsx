"use client";

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Container, ExternalLink, Play, Server, Signal } from "lucide-react";
import { useRequestedLab } from "@/lib/deep-link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FadeIn } from "@/components/ui/fade-in";
import { MagicCard } from "@/components/ui/magic-card";
import { Skeleton } from "@/components/ui/skeleton";
import { LabDetail } from "@/components/labs/lab-detail";
import { DIFFICULTY_LABEL, useLabs, type Lab } from "@/lib/use-labs";
import { labLaunch, labStop } from "@/lib/tauri";
import { notify } from "@/lib/notify";

export function Labs({ loggedIn, hostArch }: { loggedIn: boolean; hostArch: string }) {
  const { labs, error, statuses, refreshStatus } = useLabs(loggedIn);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeLab, setActiveLab] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const requested = useRequestedLab();

  useEffect(() => {
    if (requested && labs?.some((l) => l.slug === requested)) setDetailSlug(requested);
  }, [requested, labs]);

  async function launch(lab: Lab) {
    if (!lab.runtime) return;
    setBusy(lab.id);
    setActiveLab(lab.id);
    setLogs([]);
    try {
      const provider = lab.runtime.runtime === "VM" ? (lab.runtime.providers[0] ?? null) : null;
      await labLaunch(lab.id, provider, (line) => setLogs((l) => [...l, line]));
      setLogs((l) => [...l, "✓ Lab is running"]);
      notify("Lab ready", `${lab.title} is running on this machine.`);
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setBusy(null);
      refreshStatus(lab);
    }
  }

  async function stop(lab: Lab) {
    if (!lab.runtime) return;
    setBusy(lab.id);
    setActiveLab(lab.id);
    setLogs([]);
    try {
      await labStop(lab.id, lab.runtime.runtime, (line) => setLogs((l) => [...l, line]));
      setLogs((l) => [...l, "✓ Lab stopped"]);
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setBusy(null);
      refreshStatus(lab);
    }
  }

  if (error) return <EmptyState icon="alert" title="Can’t reach the lab catalogue" description="Check your connection or sign in, then try again." />;

  if (!labs) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-4 h-5 w-48" />
            <Skeleton className="mt-3 h-3 w-full" />
            <Skeleton className="mt-1.5 h-3 w-3/4" />
            <Skeleton className="mt-5 h-8 w-24 rounded-lg" />
          </div>
        ))}
      </div>
    );
  }

  if (labs.length === 0) return <EmptyState icon="labs" title="No labs published yet" description="Published labs will show up here, ready to run on this machine." />;

  const detail = detailSlug ? labs.find((l) => l.slug === detailSlug) : undefined;
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
    <div className="grid gap-4 sm:grid-cols-2">
      {labs.map((lab, i) => {
        const rt = lab.runtime;
        const native = rt?.architectures.includes(hostArch) ?? true;
        const status = statuses[lab.id];
        const running = status?.running ?? false;
        const isBusy = busy === lab.id;
        return (
          <FadeIn key={lab.id} delay={i * 0.04} className="h-full">
            <MagicCard onClick={() => setDetailSlug(lab.slug)} className="h-full cursor-pointer">
              <div className="flex h-full flex-col p-5">
                <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
                  {lab.difficulty > 0 && (
                    <span className="inline-flex items-center gap-1"><Signal className="size-3.5" />{DIFFICULTY_LABEL[lab.difficulty]}</span>
                  )}
                  {rt && (
                    <span className="inline-flex items-center gap-1">
                      {rt.runtime === "VM" ? <Server className="size-3.5" /> : <Container className="size-3.5" />}
                      {rt.runtime === "VM" ? "VM" : "Container"}
                    </span>
                  )}
                  <span className="truncate">· {lab.category}</span>
                  {running && (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-emerald-500">
                      <span className="size-1.5 rounded-full bg-emerald-500" />Running
                    </span>
                  )}
                </div>

                <h3 className="mt-3 text-lg font-semibold tracking-tight text-foreground">{lab.title}</h3>
                {lab.description && <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted-foreground line-clamp-2">{lab.description}</p>}
                {rt && !native && <p className="mt-2 text-xs text-amber-500">Emulated on this machine (slower)</p>}

                <div className="mt-5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  {running ? (
                    <>
                      {status?.url && (
                        <Button variant="learn" size="sm" onClick={() => openUrl(status.url!).catch(() => {})}>
                          <ExternalLink className="size-3.5" /> Open
                        </Button>
                      )}
                      <Button variant="destructive" size="sm" onClick={() => stop(lab)} disabled={isBusy}>
                        {isBusy ? "Stopping…" : "Stop"}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="learn"
                      size="sm"
                      onClick={() => launch(lab)}
                      disabled={!loggedIn || !rt || busy !== null}
                      title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}
                    >
                      <Play className="size-3.5" /> {isBusy ? "Starting…" : "Start"}
                    </Button>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                    Details <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </div>
            </MagicCard>
          </FadeIn>
        );
      })}
    </div>
  );
}
