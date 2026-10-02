"use client";

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/labs/log-console";
import { Markdown } from "@/components/labs/markdown";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/lib/use-labs";
import { apiQuery, type LabStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";

function RunningDot() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
      </span>
      Running
    </span>
  );
}

export function LabDetail({
  lab,
  status,
  busy,
  logs,
  loggedIn,
  hostArch,
  onBack,
  onStart,
  onStop,
}: {
  lab: Lab;
  status?: LabStatus;
  busy: boolean;
  logs: string[];
  loggedIn: boolean;
  hostArch: string;
  onBack: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const [content, setContent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    apiQuery<{ labs: { contentMd: string | null }[] }>(
      `query($id: ID!) { labs(where: { id: { eq: $id } }) { contentMd } }`,
      { id: lab.id },
    )
      .then((d) => setContent(d.labs[0]?.contentMd ?? null))
      .catch(() => setContent(null));
  }, [lab.id]);

  const rt = lab.runtime;
  const native = rt?.architectures.includes(hostArch) ?? true;
  const running = status?.running ?? false;
  const url = status?.url;

  return (
    <div className="space-y-5 animate-rise-in">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <Icon name="chevronRight" className="size-4 rotate-180" /> All labs
      </button>

      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight">{lab.title}</h1>
          {running && <RunningDot />}
        </div>
        {lab.description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{lab.description}</p>}
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
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          {lab.question && (
            <Card className="border-learn/30 bg-learn/5 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-learn">Objective</p>
              <p className="mt-1 text-sm text-foreground">{lab.question}</p>
            </Card>
          )}

          {content === undefined ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" /> Loading the brief…</div>
          ) : content ? (
            <Markdown content={content} className="space-y-3 text-sm leading-relaxed text-foreground" />
          ) : (
            <p className="text-sm text-muted-foreground">No briefing for this lab yet. Start it and dig in.</p>
          )}

          {logs.length > 0 && <LogConsole lines={logs} />}
        </div>

        <aside className="h-fit space-y-3 lg:sticky lg:top-2">
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</p>
            <div className="mt-2 flex items-center gap-2 text-sm text-foreground">
              <span className={cn("size-2 rounded-full", running ? "bg-emerald-500" : "bg-muted-foreground/40")} />
              {running ? "Running on this machine" : "Stopped"}
            </div>
            {running && status && status.machines.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">{status.machines.map((m) => `${m.name}: ${m.state}`).join(" · ")}</p>
            )}
            <div className="mt-4 space-y-2">
              {running ? (
                <>
                  {url && (
                    <Button variant="learn" className="w-full" onClick={() => openUrl(url).catch(() => {})}>
                      <Icon name="external" className="size-4" /> Open lab
                    </Button>
                  )}
                  <Button variant="destructive" className="w-full" onClick={onStop} disabled={busy}>
                    {busy ? "Stopping…" : "Stop lab"}
                  </Button>
                </>
              ) : (
                <Button
                  variant="learn"
                  className="w-full"
                  onClick={onStart}
                  disabled={!loggedIn || !rt || busy}
                  title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}
                >
                  {busy ? (<><Spinner className="size-4" /> Starting…</>) : (<><Icon name="play" className="size-4" /> Start lab</>)}
                </Button>
              )}
            </div>
            {!loggedIn && <p className="mt-2 text-xs text-muted-foreground">Sign in to run labs on this machine.</p>}
          </Card>

          {running && url && (
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Local address</p>
              <p className="mt-1 break-all font-mono text-xs text-foreground">{url}</p>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
