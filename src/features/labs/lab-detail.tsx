"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowLeft,
  Container,
  Crosshair,
  ExternalLink,
  Play,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { Markdown } from "@/components/ui/markdown";
import { NetworkDiagram } from "@/features/labs/network-diagram";
import { DeploySteps } from "@/features/labs/deploy-steps";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/features/labs/use-labs";
import {
  apiQuery,
  labAttackShell,
  labCheck,
  exegolShell,
  exegolStart,
  exegolStatus,
  exegolStop,
  serverList,
  type ExegolStatus,
  type LabCheck,
  type ServerHost,
  type LabStatus,
} from "@/lib/tauri";
import { getAttackImage, getAutoAttackBox } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { AutoStop, StartTimer } from "@/features/labs/lab-timers";
import { RunOnPicker, RunOnPopover } from "@/features/labs/run-on";

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
  /** `host`: server host id for VM labs, null to run on this machine. */
  onStart: (host: string | null) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}) {
  const [content, setContent] = useState<string | null | undefined>(undefined);
  const [exegol, setExegol] = useState<ExegolStatus | null>(null);
  const [exegolBusy, setExegolBusy] = useState(false);
  const [exegolLog, setExegolLog] = useState<string[]>([]);
  const [check, setCheck] = useState<LabCheck | "checking" | null>(null);
  // Set in Settings; read once per visit.
  const [autoAttack] = useState(() => getAutoAttackBox());
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    apiQuery<{ labs: { contentMd: string | null }[] }>(`query($id: ID!) { labs(where: { id: { eq: $id } }) { contentMd } }`, { id: lab.id })
      .then((d) => setContent(d.labs[0]?.contentMd ?? null))
      .catch(() => setContent(null));
  }, [lab.id]);

  const rt = lab.runtime;
  const native = rt?.architectures.includes(hostArch) ?? true;
  const running = status?.running ?? false;
  const starting = busy && !running;
  const url = status?.url;
  const down = (status?.machines ?? []).filter((m) => m.state !== "running");
  const RuntimeIcon = rt?.runtime === "VM" ? Server : Container;
  const isDocker = rt?.runtime !== "VM";
  const remote = !!status?.host;

  async function verify() {
    setCheck("checking");
    try {
      setCheck(await labCheck(lab.id, "DOCKER"));
    } catch (e) {
      setCheck({ available: true, ok: false, output: String(e) });
    }
  }

  // A lab can run on this machine or on one of the player's server hosts (Docker labs
  // through their deploy/ layer). VM labs default to the default host; Docker labs to here.
  const [hosts, setHosts] = useState<ServerHost[]>([]);
  const [runOn, setRunOn] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const hostOk = useCallback(
    (h: ServerHost) => !!rt?.providers.includes(h.provider) && !(rt.runtime === "VM" && (h.provider === "proxmox" || h.provider === "aws")),
    [rt],
  );
  useEffect(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        const def = l.hosts.find((h) => h.id === l.default);
        setRunOn(!isDocker && def && hostOk(def) ? def.id : null);
      })
      .catch(() => setHosts([]));
  }, [isDocker, hostOk]);
  const [shellError, setShellError] = useState<string | null>(null);

  // The attack box lives on the lab's Docker network, so it's only relevant while a
  // container lab is up. Poll its status so running/IP stay current.
  const refreshExegol = useCallback(() => {
    exegolStatus(lab.id, getAttackImage())
      .then(setExegol)
      .catch(() => setExegol(null));
  }, [lab.id]);
  useEffect(() => {
    if (!running || !isDocker) return;
    refreshExegol();
    const t = setInterval(refreshExegol, 5000);
    return () => clearInterval(t);
  }, [running, isDocker, refreshExegol]);

  const runExegol = useCallback(
    async (fn: (onLog: (l: string) => void) => Promise<void>, start: string) => {
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
    },
    [refreshExegol],
  );

  // Start the attack box with the lab (a setting, on by default), once per run.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!running) {
      autoStarted.current = false;
      return;
    }
    if (!autoAttack || !isDocker || remote || !exegol || exegol.running || exegolBusy || autoStarted.current) return;
    autoStarted.current = true;
    void runExegol((l) => exegolStart(lab.id, getAttackImage(), l), "Starting the attack box…");
  }, [running, autoAttack, isDocker, remote, exegol, exegolBusy, runExegol, lab.id]);

  // A container went down: check whether the lab is still solvable, once per incident.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!running || down.length === 0) {
      autoChecked.current = false;
      return;
    }
    if (!isDocker || autoChecked.current) return;
    autoChecked.current = true;
    void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per incident
  }, [running, down.length, isDocker]);

  // Reset = stop and start again where it ran: a clean lab.
  async function reset() {
    setResetting(true);
    const where = hosts.find((h) => h.name === status?.host)?.id ?? null;
    try {
      await onStop();
      await onStart(where);
    } finally {
      setResetting(false);
      setCheck(null);
    }
  }

  const attackReady = isDocker && (remote || !!exegol?.running);
  const openShell = () => {
    setShellError(null);
    (remote ? labAttackShell(lab.id, "DOCKER") : exegolShell(lab.id)).catch((e) => setShellError(String(e)));
  };

  return (
    <div className="animate-rise-in space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[0.78125rem] text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> All labs
      </button>

      {/* Header: what the lab is, and the one thing to do next. */}
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{lab.title}</h1>
            {running ? (
              <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-emerald-500">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Running on {status?.host ?? "this machine"}
              </span>
            ) : starting ? (
              <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-muted-foreground">
                <Spinner className="size-3" /> Starting
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.75rem] text-muted-foreground">
            {lab.difficulty > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", DIFFICULTY_DOT[lab.difficulty])} />
                {DIFFICULTY_LABEL[lab.difficulty]}
              </span>
            )}
            <span>· {lab.category}</span>
            {rt && (
              <span className="inline-flex items-center gap-1.5">
                · <RuntimeIcon className="size-3.5" />
                {rt.runtime === "VM" ? "VM" : "Container"}
              </span>
            )}
            {rt && !native && (isDocker || runOn === null) && <span className="text-amber-500">· emulated (slower)</span>}
            {(lab.skills ?? []).map((sk) => (
              <span key={sk.id} className="rounded border border-border px-1.5 py-px text-[0.6875rem]">
                {sk.name}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {running ? (
            <>
              {url && (
                <Button variant="learn" onClick={() => openUrl(url).catch(() => {})}>
                  <ExternalLink className="size-4" /> Open lab
                </Button>
              )}
              {attackReady && (
                <Button variant={url ? "outline" : "learn"} onClick={openShell}>
                  <Terminal className="size-4" /> Open shell
                </Button>
              )}
              <Button variant="destructive" onClick={() => onStop()} disabled={busy}>
                {busy && !resetting ? (
                  "Stopping…"
                ) : (
                  <>
                    <Square className="size-3.5" /> Stop
                  </>
                )}
              </Button>
            </>
          ) : starting ? (
            <Button variant="learn" disabled>
              <Spinner className="size-4" /> Starting… <StartTimer />
            </Button>
          ) : (
            <div className="relative">
              <Button
                variant="learn"
                // With servers saved, ask where to run first; otherwise start here right away.
                onClick={() => (hosts.length > 0 ? setChoosing((v) => !v) : onStart(null))}
                disabled={!loggedIn || !rt}
                title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}
                aria-expanded={hosts.length > 0 ? choosing : undefined}
              >
                <Play className="size-4" /> Start lab
              </Button>
              {choosing && (
                <RunOnPopover onClose={() => setChoosing(false)}>
                  <RunOnPicker
                    hosts={hosts}
                    hostOk={hostOk}
                    localNote={isDocker ? "Docker" : "Local hypervisor"}
                    value={runOn}
                    onChange={setRunOn}
                    disabled={busy}
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="learn"
                      size="sm"
                      onClick={() => {
                        setChoosing(false);
                        void onStart(runOn);
                      }}
                    >
                      <Play className="size-3.5" /> Start
                    </Button>
                  </div>
                </RunOnPopover>
              )}
            </div>
          )}
        </div>
      </div>
      {shellError && <p className="-mt-3 text-[0.71875rem] text-rose-400">{shellError}</p>}

      {/* Health: a container went down. Say so, check it, offer a clean restart. */}
      {running && down.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3.5">
          <AlertTriangle className="size-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1 text-[0.78125rem]">
            <p className="text-foreground">
              {down.map((m) => m.name).join(", ")} {down.length > 1 ? "are" : "is"} down. The lab may not work.
            </p>
            {check === "checking" && (
              <p className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3" /> Checking whether it&apos;s still solvable…
              </p>
            )}
            {check && check !== "checking" && check.available && (
              <p className={cn("mt-0.5 flex items-center gap-1.5", check.ok ? "text-emerald-500" : "text-rose-400")}>
                {check.ok ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
                {check.ok ? "Still solvable." : "It can no longer be solved. Reset it to get a clean lab."}
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={reset} disabled={busy || resetting}>
            {resetting ? (
              <>
                <Spinner className="size-3.5" /> Resetting…
              </>
            ) : (
              <>
                <RotateCcw className="size-3.5" /> Reset lab
              </>
            )}
          </Button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18.75rem]">
        <div className="min-w-0 space-y-5">
          {lab.question && (
            <Panel>
              <PanelHeader title="Objective" />
              <p className="p-4 text-[0.8125rem] leading-relaxed text-foreground">{lab.question}</p>
            </Panel>
          )}

          {(logs.length > 0 || busy) && (
            <Panel>
              <DeploySteps lines={logs} busy={busy} ready={running} />
            </Panel>
          )}

          {running && status && status.machines.length > 0 ? (
            <NetworkDiagram
              machines={status.machines}
              networks={status.networks}
              host={status.host}
              attacker={exegol ? { running: exegol.running, ip: exegol.ip, labNetwork: exegol.labNetwork } : null}
            />
          ) : (
            <Panel>
              <PanelHeader title="Network" />
              <p className="px-4 py-10 text-center text-[0.78125rem] text-muted-foreground">Start the lab to see its machines and network.</p>
            </Panel>
          )}

          <Panel>
            <PanelHeader title="Brief" />
            <div className="p-4">
              {content === undefined ? (
                <div className="flex items-center gap-2 text-[0.78125rem] text-muted-foreground">
                  <Spinner className="size-4" /> Loading the brief…
                </div>
              ) : content ? (
                <Markdown content={content} className="space-y-3 text-[0.8125rem] leading-relaxed text-foreground" />
              ) : (
                <p className="text-[0.78125rem] text-muted-foreground">No briefing for this lab yet. Start it and dig in.</p>
              )}
            </div>
          </Panel>
        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-2">
          {isDocker && (
            <Panel>
              <PanelHeader
                title="Attack box"
                action={
                  <span className="inline-block max-w-[9.5rem] truncate align-bottom font-mono text-[0.6875rem] text-muted-foreground" title={getAttackImage()}>
                    {getAttackImage()}
                  </span>
                }
              />
              <div className="space-y-3 p-4">
                <div className="flex items-center gap-2 text-[0.8125rem]">
                  <Crosshair className="size-4 text-learn" />
                  {remote && running ? (
                    <span>Running on {status?.host}</span>
                  ) : exegol?.running ? (
                    <span className="flex items-center gap-1.5">
                      Running <span className="font-mono text-[0.6875rem] text-muted-foreground">{exegol.ip}</span>
                    </span>
                  ) : exegolBusy ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Spinner className="size-3.5" /> Starting…
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{running ? "Not started" : "Starts with the lab"}</span>
                  )}
                </div>
                <p className="text-[0.71875rem] text-muted-foreground">
                  {remote
                    ? "Runs next to the lab on its host; the shell connects over SSH."
                    : "A toolbox machine on the lab network to attack the targets from."}
                </p>
                {!remote && exegol && !exegol.imagePresent && !exegol.running && (
                  <p className="text-[0.71875rem] text-amber-500">
                    The first start downloads <span className="font-mono">{getAttackImage()}</span> (several GB).
                  </p>
                )}
                {running && !remote && (
                  <div className="space-y-2">
                    {exegol?.running ? (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => runExegol((l) => exegolStop(lab.id, l), "Removing the attack box…")}
                        disabled={exegolBusy}
                      >
                        <Square className="size-3.5" /> {exegolBusy ? "Working…" : "Stop attack box"}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => runExegol((l) => exegolStart(lab.id, getAttackImage(), l), "Starting the attack box…")}
                        disabled={exegolBusy}
                      >
                        {exegolBusy ? <Spinner className="size-4" /> : <Play className="size-4" />} Start attack box
                      </Button>
                    )}
                  </div>
                )}
                {(exegolBusy || exegolLog.some((l) => l.startsWith("✗"))) && exegolLog.length > 0 && (
                  <LogConsole lines={exegolLog} running={exegolBusy} title="Attack box" />
                )}
              </div>
            </Panel>
          )}

          {running && (
            <Panel>
              <PanelHeader title="Details" />
              <div className="space-y-2 p-4 text-[0.75rem]">
                <p className="text-muted-foreground">
                  Runs on <span className="text-foreground">{status?.host ?? "this machine"}</span>
                </p>
                {status?.expiresAt && <AutoStop at={status.expiresAt} />}
                {url && <p className="break-all font-mono text-[0.71875rem] text-foreground">{url}</p>}
              </div>
            </Panel>
          )}
          {!loggedIn && <p className="text-[0.71875rem] text-muted-foreground">Sign in to run labs on this machine.</p>}
        </aside>
      </div>
    </div>
  );
}
