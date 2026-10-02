"use client";

import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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
  // Only surface a Vagrant plugin for a local hypervisor you actually have (or already
  // have the plugin for) - no point offering e.g. the VMware plugin with no VMware.
  const localPlugins = report.vmProviders.filter((p) => p.plugin && !p.remote && (p.hypervisor === true || p.pluginInstalled));
  // Remote providers (ESXi, Proxmox) are the home-lab story: run VM labs on your own servers.
  const homeLab = report.vmProviders.filter((p) => p.plugin && p.remote);

  const pluginRow = (p: ProviderStatus) => (
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
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">This machine</h1>
        <p className="mt-1 text-sm text-muted-foreground">What this machine can run labs with. {report.os} · {report.arch}</p>
      </div>

      {/* Docker */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Containers</p>
          {(!report.docker.installed || !report.dockerRunning) && <Install id="docker" onClick={() => installDep("docker", "Installing the container engine…")}>Install</Install>}
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
          <li className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
            <span className="text-foreground">Vagrant</span>
            <Status ok={report.vagrant.installed} detail={tool(report.vagrant)} />
          </li>
          {localPlugins.map(pluginRow)}
        </ul>
        {localPlugins.length === 0 && (
          <p className="pt-2 text-xs text-muted-foreground">Your installed hypervisors don’t need an extra Vagrant plugin.</p>
        )}
      </Card>

      {/* Home lab (advanced): remote hypervisors you own - run VM labs on your own servers */}
      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <p className="text-sm font-medium">Home lab</p>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Advanced</span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">Run VM labs on your own servers. Install the Vagrant plugin for your platform, then connect it from a lab.</p>
        <ul className="space-y-0.5">{homeLab.map(pluginRow)}</ul>
        {homeLab.length === 0 && <p className="pt-1 text-xs text-muted-foreground">No remote providers available.</p>}
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <Icon name="server" className="mt-0.5 size-3.5 shrink-0" />
          Point the launcher at a VMware ESXi or Proxmox host to run heavier VM labs on dedicated hardware instead of this machine.
        </p>
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
