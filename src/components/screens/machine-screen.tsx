"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Activity, Cloud, Cpu, ExternalLink, Gauge, HardDrive, MemoryStick, RefreshCw, Server, Wrench, type LucideIcon } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Meter } from "@/components/ui/meter";
import { Button } from "@/components/ui/button";
import {
  installDependency,
  installVagrantPlugin,
  machineMetrics,
  machineOpenSetup,
  type Dependency,
  type MachineMetrics,
  type ProviderStatus,
  type SystemReport,
  type Tool,
} from "@/lib/tauri";
import { assessRam } from "@/lib/capacity";
import { DOWNLOAD, INSTALLABLE, providerLabel, usableHypervisors } from "@/lib/hypervisors";
import { cn } from "@/lib/utils";

const gb = (b: number) => b / 1e9;
const fmtGB = (b: number) => `${gb(b).toFixed(gb(b) < 10 ? 1 : 0)} GB`;
const toolText = (t: Tool) => (t.installed ? (t.version ?? "installed") : "not installed");
function fmtUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function Metric({ icon: Icon, label, value, sub, pct }: { icon: LucideIcon; label: string; value: string; sub: string; pct: number }) {
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-2.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <Meter value={pct} className="mt-3" />
      <p className="mt-2 text-[11.5px] text-muted-foreground">{sub}</p>
    </Panel>
  );
}

/** A dependency/status row with an optional inline action (install, re-check). */
function Row({ name, mono, ok, detail, tone, action }: { name: string; mono?: string | null; ok?: boolean; detail: string; tone?: "ok" | "warn"; action?: ReactNode }) {
  const t = tone ?? (ok === undefined ? undefined : ok ? "ok" : "warn");
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <span className="text-foreground">{name}</span>
      {mono && <span className="font-mono text-[11px] text-muted-foreground">{mono}</span>}
      <span className="ml-auto flex items-center gap-3">
        <span className={cn("flex items-center gap-1.5", t === "ok" ? "text-emerald-500" : t === "warn" ? "text-amber-500" : "text-muted-foreground")}>
          {t && <span className={cn("size-1.5 rounded-full", t === "ok" ? "bg-emerald-500" : "bg-amber-500")} />}
          {detail}
        </span>
        {action}
      </span>
    </div>
  );
}

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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-muted-foreground">
          {report.os} · {report.arch}
          {m ? ` · up ${fmtUptime(m.uptimeSecs)}` : ""}
        </p>
        <Button variant={dockerReady ? "outline" : "learn"} size="sm" onClick={() => machineOpenSetup().catch(() => {})}>
          <Wrench className="size-3.5" /> {dockerReady ? "Setup guide" : "Set up this machine"}
        </Button>
      </div>

      {/* Live health */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric icon={Cpu} label="CPU" value={m ? `${Math.round(m.cpu)}%` : "…"} sub={m ? `${m.cores} cores` : ""} pct={m ? m.cpu : 0} />
        <Metric icon={MemoryStick} label="Memory" value={m ? `${Math.round(memPct)}%` : "…"} sub={m ? `${fmtGB(m.memUsed)} of ${fmtGB(m.memTotal)}` : ""} pct={memPct} />
        <Metric icon={HardDrive} label="Disk" value={m ? `${Math.round(diskPct)}%` : "…"} sub={m ? `${fmtGB(m.diskUsed)} of ${fmtGB(m.diskTotal)}` : ""} pct={diskPct} />
      </div>

      {/* Capacity */}
      {m && (() => {
        const c = assessRam(m.memTotal);
        const tint = c.level === "ok" ? "border-emerald-500/30" : c.level === "tight" ? "border-amber-500/30" : "border-rose-500/30";
        const dot = c.level === "ok" ? "text-emerald-500" : c.level === "tight" ? "text-amber-500" : "text-rose-500";
        return (
          <Panel className={cn(c.level !== "ok" && tint)}>
            <div className="p-4">
              <div className="flex items-start gap-3">
                <Gauge className={cn("mt-0.5 size-4 shrink-0", dot)} />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {c.title} <span className="ml-1 font-mono text-[11px] text-muted-foreground">{c.totalGB.toFixed(c.totalGB < 10 ? 1 : 0)} GB RAM</span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{c.detail}</p>
                </div>
              </div>
              {c.level !== "ok" && (
                <div className="mt-3 flex flex-wrap gap-2 pl-7">
                  <Button variant="outline" size="sm" onClick={() => onNavigate("cloud")}><Cloud className="size-3.5" /> Run in the cloud</Button>
                  <Button variant="outline" size="sm" onClick={() => onNavigate("server")}><Server className="size-3.5" /> Use a server</Button>
                </div>
              )}
            </div>
          </Panel>
        );
      })()}

      {/* Containers: live status + inline install/fix */}
      <Panel>
        <PanelHeader
          title="Containers"
          action={
            dockerReady ? (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Activity className="size-3.5" /> live</span>
            ) : !report.docker.installed ? (
              <Install id="docker" onClick={() => installDep("docker", "Installing the container engine…")}>Install Docker</Install>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onRefresh()}><RefreshCw className="size-3.5" /> Re-check</Button>
            )
          }
        />
        <Row name="Docker" ok={report.docker.installed} detail={toolText(report.docker)} />
        <Row name="Engine running" ok={report.dockerRunning} detail={report.dockerRunning ? "running" : "stopped"} />
        <Row name="Docker Compose" ok={report.dockerCompose.installed} detail={toolText(report.dockerCompose)} />
        <Row name="Running containers" detail={m ? String(m.containers) : "…"} />
      </Panel>

      {/* Virtualization: optional, for VM labs */}
      <Panel>
        <PanelHeader title="Virtual machines" action={<span className="text-[11.5px] text-muted-foreground">Optional · for VM labs</span>} />
        {hypervisors.map((p) => (
          <Row
            key={p.provider}
            name={providerLabel(p)}
            ok={p.hypervisor === true}
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
          detail={toolText(report.vagrant)}
          action={!report.vagrant.installed ? <Install id="vagrant" onClick={() => installDep("vagrant", "Installing Vagrant…")}>Install Vagrant</Install> : undefined}
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

      {(busy || log.length > 0) && (
        <Panel>
          <PanelHeader title="Installer" />
          <pre className="max-h-56 overflow-auto px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            {log.join("\n")}
            <div ref={logEnd} />
          </pre>
        </Panel>
      )}
    </div>
  );
}
