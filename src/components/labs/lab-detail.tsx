"use client";

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Container, ExternalLink, Play, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/labs/log-console";
import { Markdown } from "@/components/labs/markdown";
import { NetworkDiagram } from "@/components/labs/network-diagram";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/lib/use-labs";
import { apiQuery, type LabStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";

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
  const RuntimeIcon = rt?.runtime === "VM" ? Server : Container;

  return (
    <div className="animate-rise-in space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> All labs
      </button>

      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight">{lab.title}</h1>
          {running && (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-500">
              <span className="size-1.5 rounded-full bg-emerald-500" />Running
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          {lab.difficulty > 0 && (
            <span className="inline-flex items-center gap-1.5"><span className={cn("size-1.5 rounded-full", DIFFICULTY_DOT[lab.difficulty])} />{DIFFICULTY_LABEL[lab.difficulty]}</span>
          )}
          <span>· {lab.category}</span>
          {rt && <span className="inline-flex items-center gap-1.5">· <RuntimeIcon className="size-3.5" />{rt.runtime === "VM" ? "VM" : "Container"}</span>}
          {rt && !native && <span className="text-amber-500">· emulated (slower)</span>}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          {lab.question && (
            <div className="rounded-xl border border-learn/30 bg-learn/5 p-4">
              <p className="text-[11px] font-medium uppercase tracking-wide text-learn">Objective</p>
              <p className="mt-1.5 text-[13px] text-foreground">{lab.question}</p>
            </div>
          )}

          <div>
            <Panel>
              <PanelHeader title="Network" action={running ? <span className="text-[11.5px] text-muted-foreground">{status?.machines.length ?? 0} services</span> : undefined} />
              {running && status && status.machines.length > 0 ? (
                <NetworkDiagram machines={status.machines} />
              ) : (
                <p className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">Start the lab to see its containers and network.</p>
              )}
            </Panel>
          </div>

          <Panel>
            <PanelHeader title="Brief" />
            <div className="p-4">
              {content === undefined ? (
                <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Spinner className="size-4" /> Loading the brief…</div>
              ) : content ? (
                <Markdown content={content} className="space-y-3 text-[13px] leading-relaxed text-foreground" />
              ) : (
                <p className="text-[12.5px] text-muted-foreground">No briefing for this lab yet. Start it and dig in.</p>
              )}
            </div>
          </Panel>

          {logs.length > 0 && <LogConsole lines={logs} />}
        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-2">
          <Panel>
            <PanelHeader title="Status" />
            <div className="space-y-3 p-4">
              <div className="flex items-center gap-2 text-[13px]">
                <span className={cn("size-2 rounded-full", running ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                {running ? "Running on this machine" : "Stopped"}
              </div>
              {running && status && status.machines.length > 0 && (
                <p className="font-mono text-[11px] text-muted-foreground">{status.machines.map((m) => m.name).join(" · ")}</p>
              )}
              <div className="space-y-2 pt-1">
                {running ? (
                  <>
                    {url && (
                      <Button variant="learn" className="w-full" onClick={() => openUrl(url).catch(() => {})}>
                        <ExternalLink className="size-4" /> Open lab
                      </Button>
                    )}
                    <Button variant="destructive" className="w-full" onClick={onStop} disabled={busy}>
                      {busy ? "Stopping…" : "Stop lab"}
                    </Button>
                  </>
                ) : (
                  <Button variant="learn" className="w-full" onClick={onStart} disabled={!loggedIn || !rt || busy} title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}>
                    {busy ? <Spinner className="size-4" /> : <Play className="size-4" />} Start lab
                  </Button>
                )}
              </div>
              {!loggedIn && <p className="text-[11.5px] text-muted-foreground">Sign in to run labs on this machine.</p>}
            </div>
          </Panel>

          {running && url && (
            <Panel>
              <PanelHeader title="Local address" />
              <p className="break-all p-4 font-mono text-[11.5px] text-foreground">{url}</p>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
