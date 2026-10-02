"use client";

import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { installDependency, installVagrantPlugin, type Dependency, type ProviderStatus, type SystemReport, type Tool } from "@/lib/tauri";

const PROVIDER_LABELS: Record<string, string> = {
  virtualbox: "VirtualBox",
  vmware_desktop: "VMware Workstation / Fusion",
  hyperv: "Hyper-V",
  parallels: "Parallels",
  libvirt: "libvirt (KVM)",
  qemu: "QEMU",
  utm: "UTM",
  vmware_esxi: "VMware ESXi (remote)",
  proxmox: "Proxmox VE (remote)",
};

const tool = (t: Tool) => (t.installed ? t.version : "not installed");
const label = (p: ProviderStatus) => PROVIDER_LABELS[p.provider] ?? p.provider;

function Status({ ok, detail }: { ok: boolean; detail?: string | null }) {
  return (
    <span className={ok ? "inline-flex items-center gap-1.5 text-success" : "inline-flex items-center gap-1.5 text-muted-foreground"}>
      <span aria-hidden>{ok ? "✓" : "—"}</span>
      {detail}
    </span>
  );
}

export function MachineScreen({ report, onRefresh }: { report: SystemReport; onRefresh: () => void | Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);

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

  function Install({ children, onClick, id }: { children: React.ReactNode; onClick: () => void; id: string }) {
    return (
      <Button variant="learn" size="sm" onClick={onClick} disabled={busy !== null}>
        {busy === id ? "Installing…" : children}
      </Button>
    );
  }

  // Local hypervisors (the VM software) vs the Vagrant layer (tool + per-provider plugins).
  const hypervisors = report.vmProviders.filter((p) => !p.remote);
  const pluginProviders = report.vmProviders.filter((p) => p.plugin);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">This machine</h1>
        <p className="mt-1 text-sm text-muted-foreground">What this machine can run labs with. {report.os} · {report.arch}</p>
      </div>

      {/* Docker */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Docker labs</p>
          {(!report.docker.installed || !report.dockerRunning) && <Install id="docker" onClick={() => installDep("docker", "Installing Docker…")}>Install Docker</Install>}
        </div>
        <ul className="space-y-0.5">
          {[
            ["Docker", report.docker.installed, tool(report.docker)] as const,
            ["Docker engine running", report.dockerRunning, report.dockerRunning ? "running" : "stopped"] as const,
            ["Docker Compose", report.dockerCompose.installed, tool(report.dockerCompose)] as const,
          ].map(([l, ok, detail]) => (
            <li key={l} className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
              <span className="text-foreground">{l}</span>
              <Status ok={ok} detail={detail} />
            </li>
          ))}
        </ul>
      </Card>

      {/* Hypervisors (VM labs) */}
      <Card className="p-5">
        <p className="mb-1 text-sm font-medium">Hypervisors</p>
        <p className="mb-3 text-xs text-muted-foreground">The VM software labs run on. One is enough.</p>
        <ul className="space-y-0.5">
          {hypervisors.map((p) => (
            <li key={p.provider} className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
              <span className="text-foreground">{label(p)}</span>
              <span className="flex items-center gap-3">
                <Status ok={p.hypervisor === true} detail={p.hypervisor === true ? "installed" : p.hypervisor === false ? "not installed" : "built in"} />
                {p.hypervisor === false && p.provider === "virtualbox" && <Install id="virtualbox" onClick={() => installDep("virtualbox", "Installing VirtualBox…")}>Install</Install>}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Vagrant + plugins */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Vagrant</p>
            <p className="text-xs text-muted-foreground">Drives the hypervisors. Each one needs its plugin.</p>
          </div>
          {!report.vagrant.installed && <Install id="vagrant" onClick={() => installDep("vagrant", "Installing Vagrant…")}>Install Vagrant</Install>}
        </div>
        <ul className="space-y-0.5">
          <li className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm">
            <span className="text-foreground">Vagrant</span>
            <Status ok={report.vagrant.installed} detail={tool(report.vagrant)} />
          </li>
          {pluginProviders.map((p) => (
            <li key={p.provider} className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
              <span className="min-w-0">
                <span className="text-foreground">{label(p)}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{p.plugin}</span>
              </span>
              <span className="flex items-center gap-3">
                <Status ok={p.pluginInstalled} detail={p.pluginInstalled ? "installed" : "not installed"} />
                {report.vagrant.installed && !p.pluginInstalled && p.plugin && (
                  <Install id={p.plugin} onClick={() => installPlugin(p.plugin!)}>Install</Install>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {(busy || log.length > 0) && (
        <Card className="p-0">
          <div className="border-b border-border px-5 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Installer</div>
          <pre className="max-h-56 overflow-auto px-5 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {log.join("\n")}
            <div ref={logEnd} />
          </pre>
        </Card>
      )}
    </div>
  );
}
