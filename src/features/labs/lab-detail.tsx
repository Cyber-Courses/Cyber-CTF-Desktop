"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, LogIn, Pause, Play, Power, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyValue } from "@/components/ui/copy-value";
import { KeyValue, Panel, PanelHeader } from "@/components/ui/panel";
import { PageHeader, StatusStrip } from "@/components/ui/page-header";
import { Badge, LevelBadge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { StatusDot, type Tone } from "@/components/ui/status-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tip } from "@/components/ui/tip";
import { AttackBoxPanel } from "@/features/labs/attack-box-panel";
import { DeploySteps } from "@/features/labs/deploy-steps";
import { LabBrief } from "@/features/labs/lab-brief";
import { HealthBanner, useLabCheck } from "@/features/labs/lab-health";
import { AutoStop, StartTimer } from "@/features/labs/lab-timers";
import { NetworkDiagram } from "@/features/labs/network-diagram";
import { RunOnDialog, RunOnPicker, type RunTarget } from "@/features/labs/run-on";
import { EMULATORS, localProviders, runPlaces, runsNatively } from "@/features/labs/lab-row";
import { HostedSessionPanel } from "@/features/labs/hosted-session-panel";
import { useHostedLabs } from "@/features/hosted/use-hosted-labs";
import { OPERATION_STATUS, useActiveOperations, useDeployingLabs, useWorkerLog } from "@/lib/deploy-store";
import { PROVIDER_LABELS } from "@/features/machine/hypervisors";
import { useAttackBox } from "@/features/labs/use-attack-box";
import { DIFFICULTY_LABEL, type Lab } from "@/features/labs/use-labs";
import {
  labTools,
  serverList,
  terminalWindow,
  type LabTool,
  type Park,
  type Provider,
  type ServerHost,
  type LabStatus,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { openExternal, tell } from "@/lib/failure";

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
  onPark,
  onResume,
  onProvision,
  ready = true,
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
  /** Pause (state saved) or shut down (powered off), machines kept for `onResume`. */
  onPark?: (mode: Park) => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  /** Re-run a VM lab's provisioners on one machine (null = all), in place. */
  onProvision?: (machine: string | null) => Promise<void> | void;
  /** False until the first checks (sign-in, the lab's status) are in: the page then shows a
   *  placeholder instead of a Start button that flips to Running a moment later. */
  ready?: boolean;
}) {
  const [resetting, setResetting] = useState(false);
  // Which header action is in flight, so its button (not the others) reads as busy.
  const [acting, setActing] = useState<"pause" | "shutdown" | "resume" | "provision" | null>(null);
  // Which machine to provision again ("" = all), from the Details panel.
  const [provisionTarget, setProvisionTarget] = useState("");

  // Esc returns to the list (unless a dialog or a field is focused, which handle Esc themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest("[role=dialog],[role=alertdialog]"))) return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Labs the backend is still deploying, so a window reload recovers the "starting" state.
  const backendDeploying = useDeployingLabs();
  // A deploy running in its worker process after this page reloaded (or the app relaunched): no
  // local log of it, so follow the worker's log file instead.
  const workerLines = useWorkerLog(lab.id, backendDeploying.has(lab.id) && !busy && logs.length === 0);
  const rt = lab.runtime;
  // Unknown host (report not in yet) or a lab for any CPU: native, never a wrong "emulated".
  const native = !hostArch || !rt || runsNatively(rt, hostArch);
  // A VM lab built for another CPU runs here only through an emulator (QEMU), when one is ready.
  const emulates = readyVms.some((p) => EMULATORS.includes(p));
  const running = status?.running ?? false;
  // A deploy this session started sets `busy`; one still running after a window reload (which
  // loses the in-memory deploy state) is recovered from the backend, so the page shows "Starting"
  // instead of a bare Start button that would invite a colliding second start.
  const deployingHere = busy || backendDeploying.has(lab.id);
  const starting = deployingHere && !running;
  // Infrastructure exists but nothing is deploying and the lab isn't fully up: a run was cut off
  // (a crash or a restart mid-start). Offer to clean it up rather than a Start that would collide.
  // Only machines that actually exist count as leftovers: a VM lab's status lists every declared
  // machine, including ones Vagrant reports as `not_created`, and those are nothing to clean up
  // (counting them showed "Stop & clean up" on a lab that was never started).
  const leftovers = (status?.machines ?? []).filter((m) => m.state !== "not_created");
  // Parked by the launcher: its stopped machines are expected, and come back on Resume.
  const parked = !running && !deployingHere ? (status?.parked ?? null) : null;
  // What is in flight on this lab: the button this page clicked, else what the backend reports
  // (a reload loses the former), else a stop when a built lab is being worked on, a launch if not.
  const backendOp = useActiveOperations().get(lab.id)?.op;
  const operation = deployingHere ? (acting ?? backendOp ?? (busy && (running || status?.parked) ? "stop" : "launch")) : null;
  // The panel keeps showing the last run's log once it's over (a resume's, say): keep reading
  // it as that operation.
  const [lastOperation, setLastOperation] = useState<NonNullable<typeof operation>>("launch");
  if (operation && operation !== lastOperation) setLastOperation(operation);
  const tearingDown = operation === "stop" || operation === "shutdown" || operation === "pause";
  const interrupted = !deployingHere && !running && !parked && leftovers.length > 0;
  const act = async (what: "pause" | "shutdown" | "resume" | "provision") => {
    setActing(what);
    try {
      if (what === "resume") await onResume?.();
      else if (what === "provision") await onProvision?.(provisionTarget || null);
      else await onPark?.(what);
    } finally {
      setActing(null);
    }
  };
  const url = status?.url;
  // Where it actually runs: "on this machine" alone is misleading for a VM lab (which hypervisor
  // do I open?), so name the engine or hypervisor the status reports.
  const whereLabel = status?.provider ? (status.provider === "docker" ? "Docker" : (PROVIDER_LABELS[status.provider] ?? status.provider)) : null;
  // Each published container port and the local address it is bound to, so the player sees the
  // link between a service inside the lab (web :3206) and the port on this machine (:56235).
  const binds = (status?.machines ?? []).flatMap((m) =>
    m.ports.filter((p) => p.published > 0).map((p) => ({ machine: m.name, target: p.target, published: p.published })),
  );
  const bindHost = (() => {
    if (!url) return "127.0.0.1";
    try {
      return new URL(url).hostname;
    } catch {
      return "127.0.0.1";
    }
  })();
  // Machines that went down while the lab runs. Not while it's starting or stopping: machines
  // come up one after another then (a web server waits for its database), and that's normal.
  // The controller is powered off by design once the lab is built: never "down".
  const down = deployingHere ? [] : (status?.machines ?? []).filter((m) => !m.infra && m.state !== "running");
  const isDocker = rt?.runtime !== "VM";
  const remote = !!status?.host;
  // A container lab in a VM can only be paused (its containers don't restart on their own after a
  // power-off); a container lab here only shut down (its containers stop; there's no state to
  // save). A VM lab gets both. Nothing on a server host yet.
  const canPause = !!onPark && !remote && (!isDocker || status?.place === "local_vm");
  const canShutdown = !!onPark && !remote && status?.place !== "local_vm";
  // Provisioning runs again in place on VM labs driven by Vagrant (here, or an ESXi host).
  const canProvision = !!onProvision && !isDocker && status?.place !== "cloud" && status?.provider !== "proxmox";

  // A lab can run on this machine or on one of the player's server hosts (Docker labs
  // through their deploy/ layer). VM labs default to the default host; Docker labs to here.
  const [hosts, setHosts] = useState<ServerHost[]>([]);
  const [runOn, setRunOn] = useState<RunTarget>({ kind: "local" });
  // A container lab can also run in a VM here: on the hypervisor chosen in Settings (readyVms
  // lists it first), else the first ready one its deploy/ supports. One option, not a catalogue.
  const localVms = isDocker ? readyVms.filter((p) => rt?.providers.includes(p)).slice(0, 1) : [];
  const [choosing, setChoosing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
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
  const localReady = isDocker || (!!rt && (readyVms ?? []).some((p) => localProviders(rt, hostArch).includes(p)));
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

  // The attack box: a container on a local container lab's networks, the learner's own VM beside
  // a local VM lab; a remote container lab's runs next to it on its host.
  // Not while the lab itself is starting, resuming or stopping: a resume brings the attack VM
  // back on its own, and a second `vagrant up` in its folder at the same time would collide.
  // This session's own log of the run when it has one; else the worker's log file, for a deploy
  // that kept running through a reload or relaunch. A run that ended in ✗ failed.
  const shownLogs = logs.length > 0 ? logs : workerLines;
  const deployFailed = shownLogs.some((l) => l.startsWith("✗"));
  // A failed deploy can leave the VMs up (a provisioning step broke): the lab then reads as
  // running, but its attack box must not start beside a lab that isn't ready.
  const box = useAttackBox(lab.id, { running, holding: deployingHere, local: !remote, kind: isDocker ? "container" : "vm", failed: deployFailed });
  const exegol = box.status;
  const [check, clearCheck] = useLabCheck(lab.id, { running, downCount: down.length, enabled: isDocker });
  // The lab's observers (`tools:` in its spec), read once it runs: static addresses, so the
  // last answer stays good across a stop and a start.
  const [tools, setTools] = useState<LabTool[]>([]);
  useEffect(() => {
    if (!running) return;
    let alive = true;
    labTools(lab.id, isDocker ? "DOCKER" : "VM")
      .then((t) => alive && setTools(t))
      .catch(() => alive && setTools([]));
    return () => {
      alive = false;
    };
  }, [lab.id, running, isDocker]);

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

  const attackReady = remote ? isDocker : !!exegol?.running;
  const openShell = () => {
    setShellError(null);
    // In the app's own shell window; it offers the system terminal too.
    terminalWindow(lab.id, remote || isDocker ? "lab" : "attackVm", remote || isDocker ? "DOCKER" : "VM", lab.title).catch((e) => setShellError(String(e)));
  };

  // Where this deploy is headed, shown in the Deployment panel so it's clear during a build.
  const destLabel =
    status?.host ??
    (runOn.kind === "host"
      ? (hosts.find((h) => h.id === runOn.id)?.name ?? "your server")
      : runOn.kind === "local-vm"
        ? "a VM on this machine"
        : whereLabel
          ? `this machine · ${whereLabel}`
          : "this machine");
  const shownTimes = logs.length > 0 ? times : [];
  const deploy = (
    <Panel>
      <DeploySteps
        lines={shownLogs}
        times={shownTimes}
        busy={deployingHere}
        ready={running && !tearingDown}
        where={destLabel}
        operation={operation ?? lastOperation}
      />
      {/* A VM lab whose setup broke on one step (a Windows domain join timing out on a busy host)
          still has every machine built: running the setup again continues it in minutes, where
          a clean start would rebuild everything. */}
      {deployFailed && canProvision && !busy && (running || interrupted) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-[0.75rem] text-muted-foreground">
            The setup stopped, but the machines are built. Run it again to continue from where it failed, or Stop &amp; clean up to start over.
          </p>
          <Button variant="primary" size="sm" onClick={() => void act("provision")} disabled={busy}>
            {acting === "provision" ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} Re-run setup
          </Button>
        </div>
      )}
    </Panel>
  );
  // The deploy panel is worth showing while a run is in progress, once the lab is up, or when
  // the last run failed. Once a lab is stopped the leftover "✓ Lab is running" logs are stale
  // (they'd otherwise read "Ready" with nothing running), so we don't show them.
  const showDeploy = deployingHere || running || deployFailed;

  // The page's state as one dot and one word, for the status strip under the title.
  const state: { tone: Tone; word: string; pulse?: boolean } =
    operation && OPERATION_STATUS[operation]
      ? { tone: "warn", word: OPERATION_STATUS[operation]!, pulse: true }
      : running
        ? { tone: "ok", word: "Running" }
        : starting
          ? { tone: "warn", word: acting === "resume" ? "Resuming" : "Starting", pulse: true }
          : parked
            ? { tone: "muted", word: parked === "pause" ? "Paused" : "Shut down" }
            : interrupted
              ? { tone: "warn", word: "Interrupted" }
              : { tone: "muted", word: "Not started" };
  const strip: React.ReactNode[] = [
    <span key="state" className="inline-flex items-center gap-2">
      <StatusDot tone={state.tone} pulse={state.pulse} />
      <b>{state.word}</b>
    </span>,
  ];
  if (running) strip.push(<span key="where">on {status?.host ?? (whereLabel ? `this machine · ${whereLabel}` : "this machine")}</span>);
  else if (parked && whereLabel) strip.push(<span key="where">{whereLabel}</span>);
  if (rt) strip.push(<span key="rt">{isDocker ? "containers" : "vm"}</span>);
  if (rt && !native && (isDocker || emulates))
    strip.push(
      <span key="emu" className="text-warning">
        emulated (slower)
      </span>,
    );
  if (running && status?.expiresAt) strip.push(<AutoStop key="auto" at={status.expiresAt} />);
  if (lab.difficulty > 0)
    strip.push(
      <LevelBadge key="lvl" level={lab.difficulty}>
        {DIFFICULTY_LABEL[lab.difficulty]}
      </LevelBadge>,
    );
  strip.push(<span key="cat">{lab.category}</span>);

  if (!ready) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Loading the lab">
        <Skeleton className="h-3 w-16" />
        <div className="flex items-end gap-4">
          <div className="flex-1 space-y-3">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-3.5 w-full max-w-2xl" />
          </div>
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="space-y-5">
            <Skeleton className="h-72 w-full rounded-panel" />
            <Skeleton className="h-28 w-full rounded-panel" />
          </div>
          <div className="space-y-5">
            <Skeleton className="h-40 w-full rounded-panel" />
            <Skeleton className="h-28 w-full rounded-panel" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-rise-in space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="group -mb-1 inline-flex items-center gap-1.5 text-[0.75rem] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> All labs
        <kbd className="kbd opacity-60 transition-opacity group-hover:opacity-100">Esc</kbd>
      </button>

      {/* Header: what the lab is, its state at a glance, and the one thing to do next. */}
      <PageHeader
        title={lab.title}
        lead={
          <div className="space-y-2.5">
            <StatusStrip>
              {strip.map((node, i) => (
                <span key={i} className="inline-flex items-center gap-x-2.5">
                  {i > 0 && <span aria-hidden>·</span>}
                  {node}
                </span>
              ))}
            </StatusStrip>
            {(lab.skills ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {lab.skills.map((sk) => (
                  <Badge key={sk.id}>{sk.name}</Badge>
                ))}
              </div>
            )}
            {lab.description && <p className="max-w-2xl text-[0.8125rem] leading-relaxed text-muted-foreground">{lab.description}</p>}
          </div>
        }
        actions={
          running ? (
            <>
              {url && (
                <Button variant="outline" onClick={() => openExternal(url)} title={`Open ${url} in your browser`}>
                  <ExternalLink className="size-3.5" /> Open in browser
                </Button>
              )}
              {canPause && (
                <Tip key="pause" text="Save the machines' state; resume in seconds">
                  <Button variant="outline" onClick={() => void act("pause")} disabled={busy}>
                    {acting === "pause" ? (
                      <>
                        <Spinner className="size-3.5" /> Pausing…
                      </>
                    ) : (
                      <>
                        <Pause className="size-3.5" /> Pause
                      </>
                    )}
                  </Button>
                </Tip>
              )}
              {canShutdown && (
                <Tip key="shutdown" text="Power the machines off; they keep their state and boot again on Resume">
                  <Button variant="outline" onClick={() => void act("shutdown")} disabled={busy}>
                    {acting === "shutdown" ? (
                      <>
                        <Spinner className="size-3.5" /> Shutting down…
                      </>
                    ) : (
                      <>
                        <Power className="size-3.5" /> Shut down
                      </>
                    )}
                  </Button>
                </Tip>
              )}
              <Tip key="remove" text="Remove the machines; the next start rebuilds the lab from scratch">
                <Button variant="destructive" onClick={() => setConfirmingRemove(true)} disabled={busy}>
                  {operation === "stop" && !resetting ? (
                    "Stopping…"
                  ) : (
                    <>
                      <Square className="size-3.5" /> Stop &amp; remove
                    </>
                  )}
                </Button>
              </Tip>
            </>
          ) : parked && onResume ? (
            <>
              <Tip key="remove-parked" text="Remove the machines; the next start rebuilds the lab from scratch">
                <Button variant="destructive" onClick={() => setConfirmingRemove(true)} disabled={busy}>
                  <Square className="size-3.5" /> Stop &amp; remove
                </Button>
              </Tip>
              <Tip key="resume" text="Bring the lab back as it was">
                <Button variant="primary" onClick={() => void act("resume")} disabled={busy}>
                  {busy ? (
                    <>
                      <Spinner className="size-3.5" /> Resuming…
                    </>
                  ) : (
                    <>
                      <Play className="size-3.5" /> Resume
                    </>
                  )}
                </Button>
              </Tip>
            </>
          ) : starting && operation === "stop" ? (
            // Cleaning up an interrupted run: not running, but this is a stop, not a start.
            <Button variant="destructive" disabled>
              <Spinner className="size-3.5" /> Stopping…
            </Button>
          ) : starting ? (
            <Button variant="primary" disabled>
              <Spinner className="size-3.5" /> Starting… <StartTimer />
            </Button>
          ) : interrupted ? (
            // Machines exist but nothing is deploying and the lab isn't fully up: a previous run
            // was interrupted (e.g. the app restarted mid-start). Clean it up before a fresh start.
            <Button
              variant="destructive"
              onClick={() => onStop()}
              disabled={busy}
              title="A previous start was interrupted; stop and clean it up, then start again"
            >
              {busy ? (
                "Cleaning up…"
              ) : (
                <>
                  <Square className="size-3.5" /> Stop &amp; clean up
                </>
              )}
            </Button>
          ) : !loggedIn && onLogin ? (
            // Logged out: say so on the button and log in from it, rather than a greyed-out Start.
            <Button variant="primary" onClick={() => void onLogin().catch(tell("Couldn't start signing in"))}>
              <LogIn className="size-3.5" /> Sign in to start
            </Button>
          ) : (
            <div className="relative">
              <Button
                variant="primary"
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
                <Play className="size-3.5" /> Start lab
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
                        variant="primary"
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
          )
        }
      />
      {shellError && (
        <p className="-mt-2 flex items-center gap-2 text-[0.75rem] text-muted-foreground">
          <StatusDot tone="fail" /> {shellError}
        </p>
      )}
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
      {running && down.length > 0 && (
        <HealthBanner
          down={down.map((m) => m.name)}
          check={check}
          busy={busy}
          resetting={resetting}
          onReset={reset}
          onResume={!isDocker && !remote && onResume ? () => void act("resume") : undefined}
        />
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-5">
          {/* While it starts, the deployment comes first; once ready, the diagram does. */}
          {showDeploy && !(running && !busy) && deploy}

          {/* Only show the diagram once the lab is up and we're no longer deploying: during a
              build the backend may already report a machine "running" while it's still being
              provisioned, and a half-resolved diagram is more confusing than helpful. */}
          {/* Pausing, resuming or provisioning a lab, and a parked lab, keep the diagram: its
              machines exist and their states (paused, off, running) are the point. */}
          {status && status.machines.length > 0 && (acting !== null || (!busy && (running || parked))) ? (
            <NetworkDiagram
              machines={status.machines}
              networks={status.networks}
              host={status.host}
              attacker={
                // A server or cloud lab runs its attack box on the lab host, which only that host's report sees.
                remote
                  ? status.attacker
                    ? { running: true, ip: status.attacker.ip, labNetwork: status.attacker.labNetwork }
                    : null
                  : exegol
                    ? { running: exegol.running, ip: exegol.ip, labNetwork: exegol.labNetwork }
                    : null
              }
            />
          ) : busy || starting ? null : (
            <Panel>
              <PanelHeader title="Network" meta={rt ? (isDocker ? "containers" : "vm") : undefined} />
              <p className="dotted-canvas px-6 py-14 text-center text-[0.8125rem] text-muted-foreground">
                {interrupted
                  ? canProvision
                    ? "A previous start didn't finish and left machines behind. Re-run setup to continue it, or use “Stop & clean up”, then start again."
                    : "A previous start was interrupted and left machines behind. Use “Stop & clean up”, then start again."
                  : parked
                    ? parked === "pause"
                      ? "The lab is paused with its state saved. Resume it to pick up where you left off."
                      : "The lab is shut down; its machines keep their state. Resume it to boot them again."
                    : running && remote
                      ? "Reading the lab's machines from its host…"
                      : "Start the lab to see its machines and network."}
              </p>
            </Panel>
          )}

          {running && !busy && tools.length > 0 && (
            <Panel>
              <PanelHeader title="Observers" meta={`${tools.length}`} />
              <div>
                {tools.map((t) => (
                  <div
                    key={t.name}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-border px-4 py-2.5 text-[0.8125rem] first:border-t-0"
                  >
                    <span className="font-medium text-foreground">{t.name}</span>
                    <span className="font-mono text-[0.6875rem] text-faint">
                      {t.addresses.map((a) => `${a.network} ${a.ip}`).join(" · ")}
                      {t.publish ? ` · http://127.0.0.1:${t.publish}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {showDeploy && running && !busy && deploy}

          <LabBrief labId={lab.id} />
        </div>

        <aside className="h-fit min-w-0 space-y-5 lg:sticky lg:top-2">
          {lab.question && (
            <Panel>
              <PanelHeader title="Objective" meta="evidence" />
              <p className="px-4 py-3.5 text-[0.8125rem] leading-relaxed text-foreground">{lab.question}</p>
            </Panel>
          )}

          {/* VM labs on a server host have no attacker yet (their networks live on that host). */}
          {(isDocker || !remote) && (
            <AttackBoxPanel
              box={box}
              running={running && !deployingHere}
              host={remote ? (status?.host ?? null) : null}
              onShell={openShell}
              shellReady={attackReady}
              controller={!isDocker && status?.provider === "qemu"}
            />
          )}

          {/* Before it runs, the aside would otherwise be empty for a VM lab: say what the lab is
              and where it can run, so the page reads as complete at rest. */}
          {!running && rt && (
            <Panel>
              <PanelHeader title="Where it runs" meta={isDocker ? "containers" : "vm"} />
              <div>
                {runPlaces(rt, hostArch, emulates).map(({ key, icon: Icon, label, available }) => (
                  <div
                    key={key}
                    className="flex items-center gap-2.5 border-t border-border px-4 py-2 text-[0.8125rem] first:border-t-0"
                    title={available ? undefined : "Not available for this lab"}
                  >
                    <Icon className={cn("size-3.5 shrink-0", available ? "text-jewel-text" : "text-faint opacity-50")} />
                    <span className={available ? "text-foreground" : "text-faint"}>{label}</span>
                    {!available && <span className="ml-auto font-mono text-[0.6875rem] text-faint">n/a</span>}
                  </div>
                ))}
                {!native && (
                  <div className="flex items-center gap-2.5 border-t border-border px-4 py-2.5 text-[0.75rem] text-muted-foreground">
                    <StatusDot tone="warn" />{" "}
                    {isDocker
                      ? "Emulated on your CPU (slower than native)."
                      : emulates
                        ? "Emulated with QEMU, many times slower than native: a Windows machine takes 15 to 40 minutes to boot."
                        : "Built for another CPU: install QEMU from the Machine page to run it emulated (slow), or run it on a server or in your cloud account."}
                  </div>
                )}
              </div>
            </Panel>
          )}

          {running && (
            <Panel>
              <PanelHeader title="Details" meta={isDocker ? "containers" : "vm"} />
              <div>
                <KeyValue k="Runs on">{status?.host ?? "this machine"}</KeyValue>
                {whereLabel && !status?.host && <KeyValue k="Engine">{whereLabel}</KeyValue>}
                {status?.expiresAt && (
                  <KeyValue k="Auto-stop">
                    <AutoStop at={status.expiresAt} />
                  </KeyValue>
                )}
                {!binds.length && url && (
                  <KeyValue k="Address">
                    <CopyValue text={url} />
                  </KeyValue>
                )}
              </div>
              {/* The bind spelled out: which service inside the lab answers on which address of
                  this machine, with that local address one click away. */}
              {binds.length > 0 && (
                <div className="border-t border-border px-4 py-3">
                  <div className="mb-2 flex justify-between gap-3">
                    <span className="section-label">Inside the lab</span>
                    <span className="section-label">On {status?.host ?? "this machine"}</span>
                  </div>
                  <div className="space-y-1.5">
                    {binds.map((b) => (
                      <div key={`${b.machine}:${b.target}`} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-[0.75rem] text-muted-foreground">
                          {b.machine} :{b.target}
                        </span>
                        <CopyValue text={`http://${bindHost}:${b.published}`} label={`:${b.published}`} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {canProvision && (
                <div className="space-y-2.5 border-t border-border p-4">
                  <p className="section-label">Setup</p>
                  <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                    Runs the lab’s setup again on its machines, keeping them as they are. Use it when a machine didn’t finish its setup.
                  </p>
                  <Select
                    fieldSize="sm"
                    aria-label="Machine to set up again"
                    value={provisionTarget}
                    onChange={(e) => setProvisionTarget(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">All machines</option>
                    {(status?.machines ?? [])
                      .filter((m) => !m.infra)
                      .map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => void act("provision")}
                    disabled={busy}
                    title="Run the lab's setup again (vagrant provision)"
                  >
                    {acting === "provision" ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} Re-run setup
                  </Button>
                </div>
              )}
            </Panel>
          )}
          {!loggedIn && <p className="px-1 text-[0.75rem] text-muted-foreground">Sign in to run labs on this machine.</p>}
        </aside>
      </div>
      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${lab.title}?`}
          confirmLabel="Remove"
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => {
            setConfirmingRemove(false);
            void onStop();
          }}
        >
          Its machines and your attack box are deleted, with everything changed or saved on them. The next start rebuilds the lab from scratch.
          {canShutdown && " To keep them, shut the lab down instead."}
        </ConfirmDialog>
      )}
    </div>
  );
}
