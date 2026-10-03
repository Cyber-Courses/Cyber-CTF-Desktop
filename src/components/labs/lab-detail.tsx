"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, CheckCircle2, Container, Crosshair, ExternalLink, Play, Server, Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/labs/log-console";
import { Markdown } from "@/components/labs/markdown";
import { NetworkDiagram } from "@/components/labs/network-diagram";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/lib/use-labs";
import { apiQuery, exegolShell, exegolStart, exegolStatus, exegolStop, homelabList, type ExegolStatus, type HomelabHost, type LabStatus } from "@/lib/tauri";
import { getAttackImage } from "@/lib/settings";
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
  /** `host`: home-lab host id for VM labs, null to run on this machine. */
  onStart: (host: string | null) => void;
  onStop: () => void;
}) {
  const [content, setContent] = useState<string | null | undefined>(undefined);
  const [exegol, setExegol] = useState<ExegolStatus | null>(null);
  const [exegolBusy, setExegolBusy] = useState(false);
  const [exegolLog, setExegolLog] = useState<string[]>([]);
  const exegolLogEnd = useRef<HTMLDivElement>(null);

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
  const isDocker = rt?.runtime !== "VM";

  // VM labs can run on this machine or on one of the player's home-lab hosts.
  const [hosts, setHosts] = useState<HomelabHost[]>([]);
  const [runOn, setRunOn] = useState<string | null>(null);
  useEffect(() => {
    if (isDocker) return;
    homelabList()
      .then((l) => {
        setHosts(l.hosts);
        const def = l.hosts.find((h) => h.id === l.default);
        setRunOn(def && def.provider !== "proxmox" && rt?.providers.includes(def.provider) ? def.id : null);
      })
      .catch(() => setHosts([]));
  }, [isDocker, rt]);

  // The attack box lives on the lab's Docker network, so it's only relevant while a
  // container lab is up. Poll its status so Launch/running/IP stay current.
  const refreshExegol = useCallback(() => {
    exegolStatus(lab.id, getAttackImage()).then(setExegol).catch(() => setExegol(null));
  }, [lab.id]);
  useEffect(() => {
    if (!running || !isDocker) {
      setExegol(null);
      return;
    }
    refreshExegol();
    const t = setInterval(refreshExegol, 5000);
    return () => clearInterval(t);
  }, [running, isDocker, refreshExegol]);
  useEffect(() => exegolLogEnd.current?.scrollIntoView({ block: "end" }), [exegolLog]);

  async function runExegol(fn: (onLog: (l: string) => void) => Promise<void>, start: string) {
    setExegolBusy(true);
    setExegolLog([start]);
    try {
      await fn((line) => setExegolLog((l) => [...l, line]));
    } catch (e) {
      setExegolLog((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setExegolBusy(false);
      refreshExegol();
    }
  }

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
          {rt && !native && (isDocker || runOn === null) && <span className="text-amber-500">· emulated (slower)</span>}
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

          {running && status && status.machines.length > 0 ? (
            <NetworkDiagram machines={status.machines} attacker={exegol ? { running: exegol.running, ip: exegol.ip } : null} />
          ) : (
            <Panel>
              <PanelHeader title="Network" />
              <p className="px-4 py-10 text-center text-[12.5px] text-muted-foreground">Start the lab to see its containers and network.</p>
            </Panel>
          )}

          {(logs.length > 0 || busy) && (
            <Panel>
              <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
                <h3 className="text-[13px] font-medium">Deployment</h3>
                <span className="ml-auto flex items-center gap-1.5 text-[12px]">
                  {busy ? (
                    <><Spinner className="size-3.5" /> <span className="text-muted-foreground">Building…</span></>
                  ) : running ? (
                    <><CheckCircle2 className="size-4 text-emerald-500" /> <span className="text-emerald-500">Ready</span></>
                  ) : (
                    <span className="text-muted-foreground">Stopped</span>
                  )}
                </span>
              </div>
              {logs.length > 0 && <LogConsole lines={logs} />}
            </Panel>
          )}

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

        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-2">
          <Panel>
            <PanelHeader title="Status" />
            <div className="space-y-3 p-4">
              <div className="flex items-center gap-2 text-[13px]">
                <span className={cn("size-2 rounded-full", running ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                {running ? `Running on ${status?.host ?? "this machine"}` : "Stopped"}
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
                  <>
                  {!isDocker && hosts.length > 0 && (
                    <RunOnPicker hosts={hosts} supported={rt?.providers ?? []} value={runOn} onChange={setRunOn} disabled={busy} />
                  )}
                  <Button variant="learn" className="w-full" onClick={() => onStart(isDocker ? null : runOn)} disabled={!loggedIn || !rt || busy} title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}>
                    {busy ? <Spinner className="size-4" /> : <Play className="size-4" />} Start lab
                  </Button>
                  </>
                )}
              </div>
              {!loggedIn && <p className="text-[11.5px] text-muted-foreground">Sign in to run labs on this machine.</p>}
            </div>
          </Panel>

          {running && isDocker && (
            <Panel>
              <PanelHeader title="Attack box" action={<span className="inline-block max-w-[150px] truncate align-bottom font-mono text-[11px] text-muted-foreground" title={getAttackImage()}>{getAttackImage()}</span>} />
              <div className="space-y-3 p-4">
                <div className="flex items-center gap-2 text-[13px]">
                  <Crosshair className="size-4 text-learn" />
                  {exegol?.running ? (
                    <span className="flex items-center gap-1.5">
                      Running <span className="font-mono text-[11px] text-muted-foreground">{exegol.ip}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not started</span>
                  )}
                </div>
                <p className="text-[11.5px] text-muted-foreground">Attack the targets from a toolbox container on this lab’s network.</p>
                {exegol && !exegol.imagePresent && !exegol.running && (
                  <p className="text-[11.5px] text-amber-500">First launch downloads <span className="font-mono">{getAttackImage()}</span> (several GB).</p>
                )}
                <div className="space-y-2">
                  {exegol?.running ? (
                    <>
                      <Button variant="learn" className="w-full" onClick={() => exegolShell(lab.id).catch(() => {})}>
                        <Terminal className="size-4" /> Open shell
                      </Button>
                      <Button variant="outline" className="w-full" onClick={() => runExegol((l) => exegolStop(lab.id, l), "Removing the attack box…")} disabled={exegolBusy}>
                        <Square className="size-3.5" /> {exegolBusy ? "Working…" : "Stop attack box"}
                      </Button>
                    </>
                  ) : (
                    <Button variant="learn" className="w-full" onClick={() => runExegol((l) => exegolStart(lab.id, getAttackImage(), l), "Starting the attack box…")} disabled={exegolBusy}>
                      {exegolBusy ? <Spinner className="size-4" /> : <Play className="size-4" />} Launch attack box
                    </Button>
                  )}
                </div>
                {(exegolBusy || exegolLog.length > 0) && (
                  <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-[#070707] p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {exegolLog.join("\n")}
                    <div ref={exegolLogEnd} />
                  </pre>
                )}
              </div>
            </Panel>
          )}

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

const HYPERVISOR: Record<string, string> = { vmware_esxi: "ESXi", proxmox: "Proxmox" };

/** "Run on: this machine | <home-lab host>" for VM labs. Hosts whose hypervisor the lab doesn't support are disabled. */
function RunOnPicker({
  hosts,
  supported,
  value,
  onChange,
  disabled,
}: {
  hosts: HomelabHost[];
  supported: string[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled: boolean;
}) {
  const options = [
    { id: null as string | null, label: "This machine", note: "Local hypervisor", ok: true },
    ...hosts.map((h) => ({ id: h.id as string | null, label: h.name, note: `${HYPERVISOR[h.provider]} · ${h.host}`, ok: h.provider !== "proxmox" && supported.includes(h.provider) })),
  ];
  return (
    <div className="space-y-1.5">
      <p className="text-[11.5px] text-muted-foreground">Run on</p>
      <div className="overflow-hidden rounded-lg border border-border">
        {options.map((o) => {
          const selected = value === o.id;
          return (
            <button
              key={o.id ?? "local"}
              type="button"
              disabled={disabled || !o.ok}
              onClick={() => onChange(o.id)}
              title={o.ok ? undefined : `This lab doesn't support ${o.note.split(" · ")[0]}`}
              className={cn(
                "flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0 transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                selected ? "bg-muted" : "hover:bg-muted/50",
              )}
            >
              <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border", selected ? "border-learn" : "border-muted-foreground/40")}>
                {selected && <span className="size-1.5 rounded-full bg-learn" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{o.label}</span>
                <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{o.ok ? o.note : o.note.startsWith("Proxmox") ? "Proxmox labs: coming soon" : "Not supported by this lab"}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
