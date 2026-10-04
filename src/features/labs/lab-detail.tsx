"use client";

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Container, ExternalLink, Play, Server, Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { AttackBoxPanel } from "@/features/labs/attack-box-panel";
import { DeploySteps } from "@/features/labs/deploy-steps";
import { LabBrief } from "@/features/labs/lab-brief";
import { HealthBanner, useLabCheck } from "@/features/labs/lab-health";
import { AutoStop, StartTimer } from "@/features/labs/lab-timers";
import { NetworkDiagram } from "@/features/labs/network-diagram";
import { RunOnPicker, RunOnPopover } from "@/features/labs/run-on";
import { useAttackBox } from "@/features/labs/use-attack-box";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/features/labs/use-labs";
import { labAttackShell, exegolShell, serverList, type ServerHost, type LabStatus } from "@/lib/tauri";
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
  /** `host`: server host id for VM labs, null to run on this machine. */
  onStart: (host: string | null) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}) {
  const [resetting, setResetting] = useState(false);

  const rt = lab.runtime;
  const native = rt?.architectures.includes(hostArch) ?? true;
  const running = status?.running ?? false;
  const starting = busy && !running;
  const url = status?.url;
  const down = (status?.machines ?? []).filter((m) => m.state !== "running");
  const RuntimeIcon = rt?.runtime === "VM" ? Server : Container;
  const isDocker = rt?.runtime !== "VM";
  const remote = !!status?.host;

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

  // The attack box (local container labs); a remote lab's runs next to it on its host.
  const box = useAttackBox(lab.id, { running, local: isDocker && !remote });
  const exegol = box.status;
  const [check, clearCheck] = useLabCheck(lab.id, { running, downCount: down.length, enabled: isDocker });

  // Reset = stop and start again where it ran: a clean lab.
  async function reset() {
    setResetting(true);
    const where = hosts.find((h) => h.name === status?.host)?.id ?? null;
    try {
      await onStop();
      await onStart(where);
    } finally {
      setResetting(false);
      clearCheck();
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
      {running && down.length > 0 && <HealthBanner down={down.map((m) => m.name)} check={check} busy={busy} resetting={resetting} onReset={reset} />}

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

          <LabBrief labId={lab.id} />
        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-2">
          {isDocker && <AttackBoxPanel box={box} running={running} host={remote ? (status?.host ?? null) : null} />}

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
