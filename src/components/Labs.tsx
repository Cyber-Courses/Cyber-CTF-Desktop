"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRequestedLab } from "@/lib/deep-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiQuery, labLaunch, labStatus, labStop, type LabStatus, type Provider, type Runtime } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface LabRuntime {
  runtime: Runtime;
  architectures: string[];
  providers: Provider[];
}

interface Lab {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  question: string | null;
  difficulty: number;
  category: string;
  runtime: LabRuntime | null;
}

const DIFFICULTY = ["", "Easy", "Medium", "Hard"];
const DIFFICULTY_DOT = ["", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] font-medium text-muted-foreground", className)}>
      {children}
    </span>
  );
}

export function Labs({ loggedIn, hostArch }: { loggedIn: boolean; hostArch: string }) {
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, LabStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [activeLab, setActiveLab] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);
  const requested = useRequestedLab();

  function refreshStatus(lab: Lab) {
    if (!lab.runtime) return;
    const runtime = lab.runtime.runtime;
    labStatus(lab.id, runtime)
      .then((s) => setStatuses((m) => ({ ...m, [lab.id]: s })))
      .catch(() => {
        /* not running / no project yet - leave unknown */
      });
  }

  useEffect(() => {
    apiQuery<{ labs: Lab[] }>(
      `{ labs(sort: [{ title: ASC }]) { id slug title description question difficulty category
         runtime { runtime architectures providers } } }`,
    )
      .then((d) => {
        setLabs(d.labs);
        d.labs.forEach(refreshStatus);
      })
      .catch((e) => setError(String(e)));
  }, [loggedIn]);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [logs]);

  // A cyberctf://labs/<slug> link: bring that lab into view (the player still clicks Start).
  useEffect(() => {
    if (requested && labs) document.getElementById(`lab-${requested}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [requested, labs]);

  async function launch(lab: Lab) {
    if (!lab.runtime) return;
    setBusy(lab.id);
    setActiveLab(lab.id);
    setLogs([]);
    try {
      // VM labs: first provider the lab supports; provider choice UI comes with settings.
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

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!labs) return <p className="text-sm text-muted-foreground">Loading labs…</p>;
  if (labs.length === 0) return <p className="text-sm text-muted-foreground">No labs published yet.</p>;
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
            <Card key={lab.id} id={`lab-${lab.slug}`} className={cn("p-5", highlighted && "ring-1 ring-learn")}>
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
                        {DIFFICULTY[lab.difficulty]}
                      </Badge>
                    )}
                    {rt && <Badge>{rt.runtime === "VM" ? "VM" : "Container"}</Badge>}
                    {rt && !native && <Badge className="text-amber-500">emulated (slower)</Badge>}
                  </div>
                  {running && status && status.machines.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {status.machines.map((m) => `${m.name}: ${m.state}`).join(" · ")}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-stretch gap-2">
                  {running ? (
                    <Button variant="destructive" size="sm" onClick={() => stop(lab)} disabled={isBusy}>
                      {isBusy ? "Stopping…" : "Stop"}
                    </Button>
                  ) : (
                    <Button
                      variant="learn"
                      size="sm"
                      onClick={() => launch(lab)}
                      disabled={!loggedIn || !rt || busy !== null}
                      title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}
                    >
                      {isBusy ? "Starting…" : "Start"}
                    </Button>
                  )}
                </div>
              </div>
              {activeLab === lab.id && logs.length > 0 && (
                <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                  {logs.join("\n")}
                  <div ref={logEnd} />
                </pre>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
