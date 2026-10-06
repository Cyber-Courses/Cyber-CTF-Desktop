"use client";

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Container, ExternalLink, LogIn, Monitor, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { AttackBoxPanel } from "@/features/labs/attack-box-panel";
import { DeploySteps } from "@/features/labs/deploy-steps";
import { LabBrief } from "@/features/labs/lab-brief";
import { HealthBanner, useLabCheck } from "@/features/labs/lab-health";
import { AutoStop, StartTimer } from "@/features/labs/lab-timers";
import { NetworkDiagram } from "@/features/labs/network-diagram";
import { RunOnDialog, RunOnPicker, type RunTarget } from "@/features/labs/run-on";
import { runPlaces } from "@/features/labs/lab-row";
import { HostedSessionPanel } from "@/features/labs/hosted-session-panel";
import { useHostedLabs } from "@/features/hosted/use-hosted-labs";
import { useAttackBox } from "@/features/labs/use-attack-box";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/features/labs/use-labs";
import { labAttackShell, exegolShell, serverList, type Provider, type ServerHost, type LabStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const VM_CLOUDS_NOT_YET = ["azure", "gcp", "digitalocean", "linode", "oci"];

export function LabDetail({
  lab,
  status,
  busy,
  logs,
  times,
  loggedIn,
  onLogin,
  hostArch,
  readyVms = [],
  dockerRunning = null,
  onBack,
  onStart,
  onStop,
}: {
  lab: Lab;
  status?: LabStatus;
  busy: boolean;
  logs: string[];
  times: number[];
  loggedIn: boolean;
  /** Logged out: the start button logs in instead of being greyed out. */
  onLogin?: () => Promise<void>;
  hostArch: string;
  /** Local hypervisors ready on this machine (Vagrant + hypervisor), for "in a VM". */
  readyVms?: Provider[];
  /** Whether a Docker engine answers on this machine (null = unknown). */
  dockerRunning?: boolean | null;
  onBack: () => void;
  onStart: (target: RunTarget) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}) {
  const [resetting, setResetting] = useState(false);

  // Esc returns to the list (unless a dialog or a field is focused, which handle Esc themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest("[role=dialog]"))) return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const rt = lab.runtime;
  const native = rt?.architectures.includes(hostArch) ?? true;
  const running = status?.running ?? false;
  const starting = busy && !running;
  const url = status?.url;
  // Machines that went down while the lab runs. Not while it's starting or stopping: machines
  // come up one after another then (a web server waits for its database), and that's normal.
  const down = busy ? [] : (status?.machines ?? []).filter((m) => m.state !== "running");
  const isDocker = rt?.runtime !== "VM";
  const remote = !!status?.host;

  // A lab can run on this machine or on one of the player's server hosts (Docker labs
  // through their deploy/ layer). VM labs default to the default host; Docker labs to here.
  const [hosts, setHosts] = useState<ServerHost[]>([]);
  const [runOn, setRunOn] = useState<RunTarget>({ kind: "local" });
  // A container lab can also run in a VM here: on the hypervisor chosen in Settings (readyVms
  // lists it first), else the first ready one its deploy/ supports. One option, not a catalogue.
  const localVms = isDocker ? readyVms.filter((p) => rt?.providers.includes(p)).slice(0, 1) : [];
  const [choosing, setChoosing] = useState(false);
  // Cyber CTF can also run it for the player: a hosted session with a public URL.
  const hostedOk = !!rt?.hosted;
  const hosted = useHostedLabs();
  const hostedSession = hosted.session;
  // The active session belongs to this page only when it's for this lab (the hook may have
  // hydrated a session the player launched on another lab).
  const mySession = hostedSession && hostedSession.labId === lab.id ? hostedSession : null;
  const hasChoice = hosts.length > 0 || localVms.length > 0 || hostedOk;
  // Show the panel after a start from this page, or whenever there's a live session for this lab.
  const [hostedTried, setHostedTried] = useState(false);
  const hostedLive = !!mySession && !["FAILED", "STOPPED", "EXPIRED"].includes(mySession.state);
  const startOn = (t: RunTarget) => {
    if (t.kind !== "hosted") return void onStart(t);
    setHostedTried(true);
    void hosted.launch(lab.id);
  };
  const hostOk = useCallback(
    // VM labs: one VM per machine on ESXi, Proxmox and AWS (Isoloom's vagrant, proxmox and
    // cloud-vm outputs); the other clouds run container labs only for now.
    (h: ServerHost) => !!rt?.providers.includes(h.provider) && !(rt.runtime === "VM" && VM_CLOUDS_NOT_YET.includes(h.provider)),
    [rt],
  );
  // Prefer this machine when a local hypervisor can run the lab; fall back to the default server
  // only when none can. A default server shouldn't silently capture every VM lab.
  const localReady = isDocker || (readyVms ?? []).some((p) => rt?.providers.includes(p));
  useEffect(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        const def = l.hosts.find((h) => h.id === l.default);
        const preferHost = !localReady && def && hostOk(def);
        setRunOn(preferHost ? { kind: "host", id: def.id } : { kind: "local" });
      })
      .catch(() => setHosts([]));
  }, [isDocker, hostOk, localReady]);
  const [shellError, setShellError] = useState<string | null>(null);

  // The attack box (local container labs); a remote lab's runs next to it on its host.
  const box = useAttackBox(lab.id, { running, local: isDocker && !remote });
  const exegol = box.status;
  const [check, clearCheck] = useLabCheck(lab.id, { running, downCount: down.length, enabled: isDocker });

  // Reset = stop and start again where it ran: a clean lab.
  async function reset() {
    setResetting(true);
    const host = hosts.find((h) => h.name === status?.host);
    // Not a saved host but still "remote": a VM on this machine (its status names it).
    const vm = !host && status?.host ? (runOn.kind === "local-vm" ? runOn.provider : localVms[0]) : undefined;
    const where: RunTarget = host ? { kind: "host", id: host.id } : vm ? { kind: "local-vm", provider: vm } : { kind: "local" };
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

  // Where this deploy is headed, shown in the Deployment panel so it's clear during a build.
  const destLabel =
    status?.host ??
    (runOn.kind === "host"
      ? (hosts.find((h) => h.id === runOn.id)?.name ?? "your server")
      : runOn.kind === "local-vm"
        ? "a VM on this machine"
        : "this machine");
  const deploy = (
    <Panel>
      <DeploySteps lines={logs} times={times} busy={busy} ready={running} where={destLabel} />
    </Panel>
  );
  // The deploy panel is worth showing while a run is in progress, once the lab is up, or when
  // the last run failed. Once a lab is stopped the leftover "✓ Lab is running" logs are stale
  // (they'd otherwise read "Ready" with nothing running), so we don't show them.
  const deployFailed = logs.some((l) => l.startsWith("✗"));
  const showDeploy = busy || running || deployFailed;

  return (
    <div className="animate-rise-in space-y-5">
      <button onClick={onBack} className="group inline-flex items-center gap-1.5 text-[0.78125rem] text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> All labs
        <kbd className="rounded border border-border px-1.5 text-[0.625rem] text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100">esc</kbd>
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
            {rt && !native && isDocker && <span className="text-amber-500">· emulated (slower)</span>}
            {(lab.skills ?? []).map((sk) => (
              <span key={sk.id} className="rounded border border-border px-1.5 py-px text-[0.6875rem]">
                {sk.name}
              </span>
            ))}
          </div>
          {lab.description && <p className="mt-3 max-w-2xl text-[0.8125rem] leading-relaxed text-muted-foreground">{lab.description}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {running ? (
            <>
              {url && (
                <Button variant="learn" onClick={() => openUrl(url).catch(() => {})}>
                  <ExternalLink className="size-4" /> Open lab
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
          ) : !loggedIn && onLogin ? (
            // Logged out: say so on the button and log in from it, rather than a greyed-out Start.
            <Button variant="learn" onClick={() => void onLogin().catch(() => {})}>
              <LogIn className="size-4" /> Sign in to start
            </Button>
          ) : (
            <div className="relative">
              <Button
                variant="learn"
                // With servers saved, ask where to run first; otherwise start here right away.
                onClick={() => (hasChoice ? setChoosing(true) : onStart({ kind: "local" }))}
                disabled={!loggedIn || !rt || hostedLive}
                title={
                  !rt
                    ? "No runtime for this lab yet"
                    : !loggedIn
                      ? "Sign in to start labs"
                      : hostedLive
                        ? "It's running hosted by Cyber CTF; stop it first"
                        : undefined
                }
                aria-haspopup={hasChoice ? "dialog" : undefined}
              >
                <Play className="size-4" /> Start lab
              </Button>
              {choosing && (
                <RunOnDialog
                  onClose={() => setChoosing(false)}
                  footer={
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>
                        Cancel
                      </Button>
                      <Button
                        variant="learn"
                        size="sm"
                        onClick={() => {
                          setChoosing(false);
                          startOn(runOn);
                        }}
                      >
                        <Play className="size-3.5" /> Start
                      </Button>
                    </>
                  }
                >
                  <RunOnPicker
                    title={lab.title}
                    hosts={hosts}
                    hostOk={hostOk}
                    localNote={isDocker ? "On your system, as containers" : "On your system, in a VM"}
                    localVm={localVms[0] ?? null}
                    hosted={hostedOk}
                    dockerRunning={isDocker ? dockerRunning : null}
                    value={runOn}
                    onChange={setRunOn}
                    disabled={busy}
                  />
                </RunOnDialog>
              )}
            </div>
          )}
        </div>
      </div>
      {shellError && <p className="-mt-3 text-[0.71875rem] text-rose-400">{shellError}</p>}
      {(mySession || (hostedTried && (hosted.busyLab === lab.id || hosted.error))) && (
        <HostedSessionPanel
          session={mySession}
          starting={hosted.busyLab === lab.id}
          error={hosted.error}
          onStop={() => {
            setHostedTried(false);
            void hosted.stop();
          }}
        />
      )}

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

          {/* While it starts, the deployment comes first; once ready, the diagram does. */}
          {showDeploy && !(running && !busy) && deploy}

          {/* Only show the diagram once the lab is up and we're no longer deploying: during a
              build the backend may already report a machine "running" while it's still being
              provisioned, and a half-resolved diagram is more confusing than helpful. */}
          {running && !busy && status && status.machines.length > 0 ? (
            <NetworkDiagram
              machines={status.machines}
              networks={status.networks}
              host={status.host}
              attacker={exegol ? { running: exegol.running, ip: exegol.ip, labNetwork: exegol.labNetwork } : null}
            />
          ) : busy || starting ? null : (
            <Panel>
              <PanelHeader title="Network" />
              <p className="px-4 py-10 text-center text-[0.78125rem] text-muted-foreground">Start the lab to see its machines and network.</p>
            </Panel>
          )}

          {showDeploy && running && !busy && deploy}

          <LabBrief labId={lab.id} />
        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-2">
          {isDocker && (
            <AttackBoxPanel box={box} running={running} host={remote ? (status?.host ?? null) : null} onShell={openShell} shellReady={attackReady} />
          )}

          {/* Before it runs, the aside would otherwise be empty for a VM lab: say what the lab is
              and where it can run, so the page reads as complete at rest. */}
          {!running && rt && (
            <Panel>
              <PanelHeader title="About" />
              <div className="space-y-3.5 p-4 text-[0.75rem]">
                <div className="flex items-center gap-2 text-foreground">
                  {isDocker ? <Container className="size-4 text-muted-foreground" /> : <Monitor className="size-4 text-muted-foreground" />}
                  <span>{isDocker ? "Runs as containers" : "Runs as virtual machines"}</span>
                </div>
                <div>
                  <p className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Where it runs</p>
                  <div className="space-y-1.5">
                    {runPlaces(rt).map(({ key, icon: Icon, label, available }) => (
                      <div key={key} className={cn("flex items-center gap-2", available ? "text-foreground" : "text-muted-foreground/40")} title={available ? undefined : "Not available for this lab"}>
                        <Icon className="size-3.5 shrink-0" />
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {!native && <p className="text-amber-500">Emulated on your CPU (slower than native).</p>}
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
