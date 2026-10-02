"use client";

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRequestedLab } from "@/lib/deep-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/labs/log-console";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, useLabs, type Lab } from "@/lib/use-labs";
import { labLaunch, labStop } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export function Labs({ loggedIn, hostArch }: { loggedIn: boolean; hostArch: string }) {
  const { labs, error, statuses, refreshStatus } = useLabs(loggedIn);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeLab, setActiveLab] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const requested = useRequestedLab();

  // A cyberctf://labs/<slug> link brings that lab into view (the player still clicks Start).
  useEffect(() => {
    if (requested && labs) document.getElementById(`lab-${requested}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
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
  if (!labs) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading labs…</div>;
  if (labs.length === 0) return <EmptyState icon="labs" title="No labs published yet" description="Published labs will show up here, ready to run on this machine." />;
  const missing = requested && !labs.some((l) => l.slug === requested);

  return (
    <div className="space-y-4">
      {missing && <p className="text-sm text-amber-500">The lab “{requested}” isn’t available.</p>}
      <div className="space-y-3">
        {labs.map((lab) => {
          const rt = lab.runtime;
          const native = rt?.architectures.includes(hostArch) ?? true;
          const status = statuses[lab.id];
          const running = status?.running ?? false;
          const isBusy = busy === lab.id;
          const highlighted = lab.slug === requested;
          return (
            <Card key={lab.id} id={`lab-${lab.slug}`} className={cn("p-5 transition-colors", highlighted && "ring-1 ring-learn")}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold tracking-tight">{lab.title}</h3>
                    {running && (
                      <span className="inline-flex items-center gap-1 text-[0.7rem] font-medium text-emerald-500">
                        <span className="relative flex size-1.5">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                        </span>
                        Running
                      </span>
                    )}
                  </div>
                  {lab.description && <p className="mt-1 text-sm text-muted-foreground">{lab.description}</p>}
                  {lab.question && <p className="mt-2 text-sm text-foreground">{lab.question}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <Badge>{lab.category}</Badge>
                    {lab.difficulty > 0 && (
                      <Badge>
                        <span className={cn("size-1.5 rounded-full", DIFFICULTY_DOT[lab.difficulty])} />
                        {DIFFICULTY_LABEL[lab.difficulty]}
                      </Badge>
                    )}
                    {rt && <Badge>{rt.runtime === "VM" ? "VM" : "Container"}</Badge>}
                    {rt && !native && <Badge variant="warning">emulated (slower)</Badge>}
                  </div>
                  {running && status && status.machines.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {status.machines.map((m) => `${m.name}: ${m.state}`).join(" · ")}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-stretch gap-2">
                  {running ? (
                    <>
                      {status?.url && (
                        <Button variant="learn" size="sm" onClick={() => openUrl(status.url!).catch(() => {})}>
                          <Icon name="external" className="size-3.5" /> Open
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
                      {isBusy ? (<><Spinner className="size-3.5" /> Starting…</>) : (<><Icon name="play" className="size-3.5" /> Start</>)}
                    </Button>
                  )}
                </div>
              </div>
              {activeLab === lab.id && <LogConsole lines={logs} className="mt-4" />}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
