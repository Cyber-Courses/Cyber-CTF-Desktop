"use client";

import { useEffect, useState } from "react";
import { Activity, Cloud, Cpu, Gauge, HardDrive, MemoryStick, Server, type LucideIcon } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Meter } from "@/components/ui/meter";
import { Button } from "@/components/ui/button";
import { SetupScreen } from "@/components/screens/setup-screen";
import { machineMetrics, type MachineMetrics, type SystemReport } from "@/lib/tauri";
import { assessRam } from "@/lib/capacity";
import { cn } from "@/lib/utils";

export type MachineView = "health" | "setup";

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

function InfoRow({ name, value, tone }: { name: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="flex items-center border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <span className="text-muted-foreground">{name}</span>
      <span className={cn("ml-auto flex items-center gap-1.5", tone === "ok" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : "text-foreground")}>
        {tone && <span className={cn("size-1.5 rounded-full", tone === "ok" ? "bg-emerald-500" : "bg-amber-500")} />}
        {value}
      </span>
    </div>
  );
}

export function MachineScreen({
  report,
  view,
  onViewChange,
  onRefresh,
  onNavigate,
}: {
  report: SystemReport;
  view: MachineView;
  onViewChange: (v: MachineView) => void;
  onRefresh: () => void | Promise<void>;
  onNavigate: (tab: "cloud" | "homelab" | "labs") => void;
}) {
  const [m, setM] = useState<MachineMetrics | null>(null);

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

  const dockerReady = report.docker.installed && report.dockerRunning;
  const hypervisors = report.vmProviders.filter((p) => !p.remote && p.hypervisor === true).length;
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const diskPct = m && m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* View toggle + context */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5 text-[12.5px]">
          {(["health", "setup"] as MachineView[]).map((v) => (
            <button
              key={v}
              onClick={() => onViewChange(v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1 capitalize transition-colors",
                view === v ? "bg-[#1a1a1a] text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
              {v === "setup" && !dockerReady && <span className="size-1.5 rounded-full bg-amber-500" />}
            </button>
          ))}
        </div>
        {view === "health" && (
          <p className="text-[12.5px] text-muted-foreground">
            {report.os} · {report.arch}
            {m ? ` · up ${fmtUptime(m.uptimeSecs)}` : ""}
          </p>
        )}
      </div>

      {view === "setup" ? (
        <SetupScreen report={report} onRefresh={onRefresh} onNavigate={onNavigate} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Metric icon={Cpu} label="CPU" value={m ? `${Math.round(m.cpu)}%` : "…"} sub={m ? `${m.cores} cores` : ""} pct={m ? m.cpu : 0} />
            <Metric icon={MemoryStick} label="Memory" value={m ? `${Math.round(memPct)}%` : "…"} sub={m ? `${fmtGB(m.memUsed)} of ${fmtGB(m.memTotal)}` : ""} pct={memPct} />
            <Metric icon={HardDrive} label="Disk" value={m ? `${Math.round(diskPct)}%` : "…"} sub={m ? `${fmtGB(m.diskUsed)} of ${fmtGB(m.diskTotal)}` : ""} pct={diskPct} />
          </div>

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
                      <Button variant="outline" size="sm" onClick={() => onNavigate("homelab")}><Server className="size-3.5" /> Use a home lab</Button>
                    </div>
                  )}
                </div>
              </Panel>
            );
          })()}

          <Panel>
            <PanelHeader title="Status" action={<span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Activity className="size-3.5" /> live</span>} />
            <InfoRow name="Docker engine" value={report.dockerRunning ? "Running" : "Stopped"} tone={report.dockerRunning ? "ok" : "warn"} />
            <InfoRow name="Running containers" value={m ? String(m.containers) : "…"} />
            <InfoRow name="Hypervisors ready" value={String(hypervisors)} />
            <InfoRow name="Uptime" value={m ? fmtUptime(m.uptimeSecs) : "…"} />
          </Panel>

          {!dockerReady && (
            <Panel>
              <div className="flex items-center gap-3 p-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">This machine isn’t ready for container labs</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">Install Docker (and optionally a hypervisor) in Setup.</p>
                </div>
                <Button variant="learn" size="sm" className="ml-auto" onClick={() => onViewChange("setup")}>Go to Setup</Button>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
