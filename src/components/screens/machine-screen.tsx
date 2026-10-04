"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Cloud, Cpu, ExternalLink, Gauge, HardDrive, MemoryStick, RefreshCw, Server, Terminal, Wrench, X, type LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Meter } from "@/components/ui/meter";
import { Button } from "@/components/ui/button";
import {
  installDependency,
  installVagrantPlugin,
  machineMetrics,
  machineOpenSetup,
  type Dependency,
  type DockerEngine,
  type MachineMetrics,
  type SystemReport,
  type Tool,
} from "@/lib/tauri";
import { assessRam } from "@/lib/capacity";
import { DOWNLOAD, INSTALLABLE, providerLabel, usableHypervisors } from "@/lib/hypervisors";
import { cn } from "@/lib/utils";

const gb = (b: number) => b / 1e9;
const fmtGB = (b: number) => `${gb(b).toFixed(gb(b) < 10 ? 1 : 0)} GB`;
function fmtUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** One segment of the stats strip: label, big value, meter, sub-line. */
function Stat({ icon: Icon, label, value, sub, pct }: { icon: LucideIcon; label: string; value: string; sub: string; pct: number }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xl font-semibold tracking-tight tabular-nums">{value}</span>
        <span className="truncate text-[11.5px] tabular-nums text-muted-foreground">{sub}</span>
      </div>
      <Meter value={pct} className="mt-2.5" />
    </div>
  );
}

/** A dependency/status row. Healthy rows stay quiet (muted value); only problems get an amber dot. */
function Row({ name, mono, ok, detail, action }: { name: string; mono?: string | null; ok?: boolean; detail: string; action?: ReactNode }) {
  const bad = ok === false;
  return (
    <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-3.5 py-2 text-[12.5px] last:border-b-0">
      <span className="text-foreground">{name}</span>
      {mono && <span className="font-mono text-[11px] text-muted-foreground">{mono}</span>}
      <span className="ml-auto flex min-w-0 items-center gap-3">
        <span className={cn("flex min-w-0 items-center gap-1.5", bad ? "text-amber-500" : "font-mono text-[11.5px] text-muted-foreground")}>
          {bad && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
          <span className="truncate">{detail}</span>
        </span>
        {action}
      </span>
    </div>
  );
}

const ENGINE_NAME: Record<DockerEngine, string> = {
  "docker-desktop": "Docker Desktop",
  "docker-engine": "Docker Engine",
  orbstack: "OrbStack",
  colima: "Colima",
  "rancher-desktop": "Rancher Desktop",
  podman: "Podman",
};
const OS_NAME: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };
/** Strip the tool name from `docker --version`-style output, keep the version number. */
const ver = (t: Tool) => (t.installed ? (t.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "installed") : "not installed");

export function MachineScreen({
  report,
  onRefresh,
  onNavigate,
}: {
  report: SystemReport;
  onRefresh: () => void | Promise<void>;
  onNavigate: (tab: "cloud" | "server") => void;
}) {
  const [m, setM] = useState<MachineMetrics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => machineMetrics().then((x) => alive && setM(x)).catch(() => {});
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function runInstall(id: string, start: string, fn: (onLog: (line: string) => void) => Promise<void>) {
    setBusy(id);
    setLog([start]);
    try {
      await fn((line) => {
        setLog((l) => [...l, line]);
        requestAnimationFrame(() => logEnd.current?.scrollIntoView({ block: "end" }));
      });
    } catch (e) {
      setLog((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setBusy(null);
      await onRefresh();
    }
  }
  const installDep = (dep: Dependency, msg: string) => runInstall(dep, msg, (log) => installDependency(dep, log));
  const installPlugin = (plugin: string) => runInstall(plugin, `Installing ${plugin}…`, (log) => installVagrantPlugin(plugin, log));

  function Install({ id, onClick, children }: { id: string; onClick: () => void; children: ReactNode }) {
    return (
      <Button variant="learn" size="sm" onClick={onClick} disabled={busy !== null}>
        {busy === id ? "Installing…" : children}
      </Button>
    );
  }

  const dockerReady = report.docker.installed && report.dockerRunning;
  const hypervisors = usableHypervisors(report);
  const localPlugins = report.vmProviders.filter((p) => p.plugin && !p.remote && (p.hypervisor === true || p.pluginInstalled));
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const diskPct = m && m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0;
  const cap = m ? assessRam(m.memTotal) : null;

  // Everything that keeps a lab type from running, for the header summary.
  const hasHypervisor = hypervisors.some((p) => p.hypervisor === true);
  const issues = [
    !report.docker.installed,
    report.docker.installed && !report.dockerRunning,
    report.docker.installed && !report.dockerCompose.installed,
    hypervisors.length > 0 && !hasHypervisor,
    hasHypervisor && !report.vagrant.installed,
    ...localPlugins.map((p) => report.vagrant.installed && !p.pluginInstalled),
  ].filter(Boolean).length;

  return (
    <div className="space-y-5">
      {/* 3. Summary header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium", issues ? "border-amber-500/30 text-amber-500" : "border-emerald-500/30 text-emerald-500")}>
          <span className={cn("size-1.5 rounded-full", issues ? "bg-amber-500" : "bg-emerald-500")} />
          {issues ? `${issues} ${issues === 1 ? "item" : "items"} to fix` : "Ready"}
        </span>
        {/* 2. Capacity as a quiet pill when fine */}
        {cap && cap.level === "ok" && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Gauge className="size-3.5" /> {cap.totalGB.toFixed(0)} GB RAM · {cap.title.toLowerCase()}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <span className="text-[12px] text-muted-foreground">
            {OS_NAME[report.os] ?? report.os} · {report.arch}
            {m ? ` · up ${fmtUptime(m.uptimeSecs)}` : ""}
          </span>
          <Button variant={dockerReady ? "outline" : "learn"} size="sm" onClick={() => machineOpenSetup().catch(() => {})}>
            <Wrench className="size-3.5" /> {dockerReady ? "Setup" : "Set up this machine"}
          </Button>
        </span>
      </div>

      {/* 1. Live health: one strip */}
      <Panel className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat icon={Cpu} label="CPU" value={m ? `${Math.round(m.cpu)}%` : "…"} sub={m ? `${m.cores} cores` : ""} pct={m ? m.cpu : 0} />
        <Stat icon={MemoryStick} label="Memory" value={m ? `${Math.round(memPct)}%` : "…"} sub={m ? `${fmtGB(m.memUsed)} / ${fmtGB(m.memTotal)}` : ""} pct={memPct} />
        <Stat icon={HardDrive} label="Disk" value={m ? `${Math.round(diskPct)}%` : "…"} sub={m ? `${fmtGB(m.diskUsed)} / ${fmtGB(m.diskTotal)}` : ""} pct={diskPct} />
      </Panel>

      {/* 2. Capacity callout, only when RAM is tight or low */}
      {cap && cap.level !== "ok" && (
        <Panel className={cap.level === "tight" ? "border-amber-500/30" : "border-rose-500/30"}>
          <div className="flex flex-wrap items-center gap-3 p-3.5">
            <Gauge className={cn("size-4 shrink-0", cap.level === "tight" ? "text-amber-500" : "text-rose-500")} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                {cap.title} <span className="ml-1 font-mono text-[11px] text-muted-foreground">{cap.totalGB.toFixed(cap.totalGB < 10 ? 1 : 0)} GB RAM</span>
              </p>
              <p className="text-[12px] text-muted-foreground">{cap.detail}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onNavigate("cloud")}><Cloud className="size-3.5" /> Cloud</Button>
              <Button variant="outline" size="sm" onClick={() => onNavigate("server")}><Server className="size-3.5" /> Server</Button>
            </div>
          </div>
        </Panel>
      )}

      {/* 4. Containers + VMs side by side on wide windows */}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Containers"
            action={
              dockerReady ? null : !report.docker.installed ? (
                <Install id="docker" onClick={() => installDep("docker", "Installing the container engine…")}>Install Docker</Install>
              ) : (
                <Button variant="outline" size="sm" onClick={() => onRefresh()}><RefreshCw className="size-3.5" /> Re-check</Button>
              )
            }
          />
          <Row name="Engine" ok={report.docker.installed ? report.dockerRunning : false} detail={!report.docker.installed ? "not installed" : !report.dockerRunning ? "stopped" : report.dockerEngine ? ENGINE_NAME[report.dockerEngine] : "running"} />
          <Row name="Docker" ok={report.docker.installed} detail={ver(report.docker)} />
          <Row name="Docker Compose" ok={report.docker.installed ? report.dockerCompose.installed : undefined} detail={ver(report.dockerCompose)} />
          <Row name="Running containers" detail={m ? String(m.containers) : "…"} />
        </Panel>

        <Panel>
          <PanelHeader title="Virtual machines" />
          {hypervisors.map((p) => (
            <Row
              key={p.provider}
              name={providerLabel(p)}
              ok={p.hypervisor === false ? false : undefined}
              detail={p.hypervisor === true ? "installed" : p.hypervisor === false ? "not installed" : "built in"}
              action={
                p.hypervisor === true
                  ? undefined
                  : INSTALLABLE[p.provider]
                    ? <Install id={p.provider} onClick={() => installDep(INSTALLABLE[p.provider]!, `Installing ${providerLabel(p)}…`)}>Install</Install>
                    : DOWNLOAD[p.provider]
                      ? <Button variant="outline" size="sm" onClick={() => openUrl(DOWNLOAD[p.provider]!).catch(() => {})}><ExternalLink className="size-3.5" /> Get</Button>
                      : undefined
              }
            />
          ))}
          <Row
            name="Vagrant"
            ok={report.vagrant.installed}
            detail={ver(report.vagrant)}
            action={!report.vagrant.installed ? <Install id="vagrant" onClick={() => installDep("vagrant", "Installing Vagrant…")}>Install</Install> : undefined}
          />
          {localPlugins.map((p) => (
            <Row
              key={p.provider}
              name={providerLabel(p)}
              mono={p.plugin}
              ok={p.pluginInstalled}
              detail={p.pluginInstalled ? "installed" : "not installed"}
              action={report.vagrant.installed && !p.pluginInstalled && p.plugin ? <Install id={p.plugin} onClick={() => installPlugin(p.plugin!)}>Install</Install> : undefined}
            />
          ))}
        </Panel>
      </div>

      {/* 6. Installer log: slide-in drawer pinned to the bottom of the window */}
      {(busy || log.length > 0) && (
        <div className="fixed inset-x-4 bottom-4 z-40 ml-auto max-w-xl animate-rise-in overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/50">
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
            {busy ? <Spinner className="size-3.5" /> : <Terminal className="size-3.5 text-muted-foreground" />}
            <h3 className="text-[13px] font-medium">{busy ? "Installing…" : "Installer"}</h3>
            <button
              onClick={() => setLog([])}
              disabled={!!busy}
              className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              aria-label="Close installer log"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <pre className="max-h-48 overflow-auto px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            {log.join("\n")}
            <div ref={logEnd} />
          </pre>
        </div>
      )}
    </div>
  );
}
