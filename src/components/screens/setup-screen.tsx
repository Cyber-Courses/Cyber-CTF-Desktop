"use client";

import { useRef, useState, type ReactNode } from "react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { installDependency, installVagrantPlugin, type Dependency, type ProviderStatus, type SystemReport, type Tool } from "@/lib/tauri";
import { cn } from "@/lib/utils";

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

const tool = (t: Tool) => (t.installed ? (t.version ?? "installed") : "not installed");
const label = (p: ProviderStatus) => PROVIDER_LABELS[p.provider] ?? p.provider;

function StatRow({ name, mono, ok, detail, action }: { name: string; mono?: string | null; ok: boolean; detail: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <span className="text-foreground">{name}</span>
      {mono && <span className="font-mono text-[11px] text-muted-foreground">{mono}</span>}
      <span className="ml-auto flex items-center gap-3">
        <span className={cn("flex items-center gap-1.5", ok ? "text-emerald-500" : "text-muted-foreground")}>
          {ok && <span className="size-1.5 rounded-full bg-emerald-500" />}
          {detail}
        </span>
        {action}
      </span>
    </div>
  );
}

export function SetupScreen({ report, onRefresh }: { report: SystemReport; onRefresh: () => void | Promise<void> }) {
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

  function Install({ id, onClick, children }: { id: string; onClick: () => void; children: ReactNode }) {
    return (
      <Button variant="learn" size="sm" onClick={onClick} disabled={busy !== null}>
        {busy === id ? "Installing…" : children}
      </Button>
    );
  }

  const hypervisors = report.vmProviders.filter((p) => !p.remote);
  const localPlugins = report.vmProviders.filter((p) => p.plugin && !p.remote && (p.hypervisor === true || p.pluginInstalled));

  return (
    <div className="space-y-5">
      <p className="text-[12.5px] text-muted-foreground">Install what this machine needs to run labs. Each tool opens its own trusted installer.</p>

      <Panel>
        <PanelHeader
          title="Containers"
          action={(!report.docker.installed || !report.dockerRunning) && <Install id="docker" onClick={() => installDep("docker", "Installing the container engine…")}>Install Docker</Install>}
        />
        <StatRow name="Docker" ok={report.docker.installed} detail={tool(report.docker)} />
        <StatRow name="Engine running" ok={report.dockerRunning} detail={report.dockerRunning ? "running" : "stopped"} />
        <StatRow name="Docker Compose" ok={report.dockerCompose.installed} detail={tool(report.dockerCompose)} />
      </Panel>

      <Panel>
        <PanelHeader title="Hypervisors" action={<span className="text-[11.5px] text-muted-foreground">One is enough</span>} />
        {hypervisors.map((p) => (
          <StatRow
            key={p.provider}
            name={label(p)}
            ok={p.hypervisor === true}
            detail={p.hypervisor === true ? "installed" : p.hypervisor === false ? "not installed" : "built in"}
            action={p.hypervisor === false && p.provider === "virtualbox" ? <Install id="virtualbox" onClick={() => installDep("virtualbox", "Installing VirtualBox…")}>Install</Install> : undefined}
          />
        ))}
      </Panel>

      <Panel>
        <PanelHeader title="Vagrant" action={!report.vagrant.installed ? <Install id="vagrant" onClick={() => installDep("vagrant", "Installing Vagrant…")}>Install Vagrant</Install> : undefined} />
        <StatRow name="Vagrant" ok={report.vagrant.installed} detail={tool(report.vagrant)} />
        {localPlugins.map((p) => (
          <StatRow
            key={p.provider}
            name={label(p)}
            mono={p.plugin}
            ok={p.pluginInstalled}
            detail={p.pluginInstalled ? "installed" : "not installed"}
            action={report.vagrant.installed && !p.pluginInstalled && p.plugin ? <Install id={p.plugin} onClick={() => installPlugin(p.plugin!)}>Install</Install> : undefined}
          />
        ))}
        {localPlugins.length === 0 && <p className="px-3.5 py-3 text-[12px] text-muted-foreground">Your installed hypervisors don’t need an extra Vagrant plugin.</p>}
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
