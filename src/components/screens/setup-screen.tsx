"use client";

import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowLeft, Box, Check, Container, Crosshair, Play, RefreshCw, Server, Sparkles, type LucideIcon } from "lucide-react";
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

const toolText = (t: Tool) => (t.installed ? (t.version ?? "installed") : "not installed");
const providerLabel = (p: ProviderStatus) => PROVIDER_LABELS[p.provider] ?? p.provider;

type StepKey = "docker" | "vm" | "exegol" | "ready";
type StepState = "done" | "current" | "upcoming" | "soon";

const STEPS: { key: StepKey; title: string; tag: string; icon: LucideIcon }[] = [
  { key: "docker", title: "Container engine", tag: "Required", icon: Container },
  { key: "vm", title: "Virtual machines", tag: "Optional", icon: Server },
  { key: "exegol", title: "Attack toolbox", tag: "Optional", icon: Crosshair },
  { key: "ready", title: "Ready", tag: "", icon: Sparkles },
];

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

function ReadyBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
        <Check className="size-4" />
      </span>
      <p className="text-[13px] font-medium text-foreground">{children}</p>
    </div>
  );
}

function SummaryRow({ ok, label, value, muted }: { ok: boolean; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-6 items-center justify-center rounded-full", ok ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground")}>
          <Check className="size-3.5" />
        </span>
        <span className="text-[13px] text-foreground">{label}</span>
      </div>
      <span className={cn("text-[12px]", ok ? "text-emerald-500" : muted ? "text-muted-foreground/70" : "text-muted-foreground")}>{value}</span>
    </div>
  );
}

export function SetupScreen({ report, onRefresh, onNavigate }: { report: SystemReport; onRefresh: () => void | Promise<void>; onNavigate: (tab: "labs") => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);

  const dockerReady = report.docker.installed && report.dockerRunning;
  const hypervisors = report.vmProviders.filter((p) => !p.remote);
  const localPlugins = report.vmProviders.filter((p) => p.plugin && !p.remote && (p.hypervisor === true || p.pluginInstalled));
  const vmReady = report.vagrant.installed && hypervisors.some((p) => p.hypervisor === true);

  const stepDone: Record<StepKey, boolean> = { docker: dockerReady, vm: vmReady, exegol: false, ready: dockerReady };

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

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const InstallerLog = () =>
    log.length > 0 ? (
      <pre className="mt-3 max-h-44 overflow-auto rounded-lg border border-border bg-[#070707] p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
        {log.join("\n")}
        <div ref={logEnd} />
      </pre>
    ) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[232px_minmax(0,1fr)]">
      {/* ---- Stepper ---- */}
      <ol className="h-fit lg:sticky lg:top-2">
        {STEPS.map((s, i) => {
          const state: StepState = stepDone[s.key] ? "done" : i === step ? "current" : s.key === "exegol" ? "soon" : "upcoming";
          return (
            <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0">
              {i < STEPS.length - 1 && <span className="absolute left-[13.5px] top-8 h-[calc(100%-18px)] w-px bg-border" />}
              <button
                onClick={() => setStep(i)}
                className={cn(
                  "z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors",
                  state === "done" && "border-emerald-500/40 bg-emerald-500/15 text-emerald-500",
                  state === "current" && "border-learn bg-learn/15 text-learn",
                  (state === "upcoming" || state === "soon") && "border-border bg-card text-muted-foreground",
                )}
              >
                {state === "done" ? <Check className="size-3.5" /> : i + 1}
              </button>
              <button onClick={() => setStep(i)} className="min-w-0 pt-0.5 text-left">
                <p className={cn("text-[13px] font-medium", i === step ? "text-foreground" : "text-muted-foreground")}>{s.title}</p>
                <p className="text-[11px] text-muted-foreground/70">
                  {state === "done" ? "Ready" : state === "soon" ? "Coming soon" : s.tag}
                </p>
              </button>
            </li>
          );
        })}
      </ol>

      {/* ---- Step content ---- */}
      <div key={step} className="animate-rise-in rounded-xl border border-border bg-card">
        {step === 0 && (
          <StepBody
            icon={Container}
            title="Container engine"
            description="Most labs run as Docker containers on this machine. Install Docker once and you're ready for container labs."
          >
            {dockerReady ? (
              <ReadyBanner>Docker is installed and running.</ReadyBanner>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <StatRow
                  name="Docker"
                  ok={report.docker.installed}
                  detail={toolText(report.docker)}
                  action={!report.docker.installed ? <Install id="docker" onClick={() => installDep("docker", "Installing the container engine…")}>Install Docker</Install> : undefined}
                />
                <StatRow
                  name="Engine running"
                  ok={report.dockerRunning}
                  detail={report.dockerRunning ? "running" : "stopped"}
                  action={report.docker.installed && !report.dockerRunning ? <Button variant="outline" size="sm" onClick={() => onRefresh()}><RefreshCw className="size-3.5" /> Re-check</Button> : undefined}
                />
                <StatRow name="Docker Compose" ok={report.dockerCompose.installed} detail={toolText(report.dockerCompose)} />
              </div>
            )}
            {!dockerReady && report.docker.installed && !report.dockerRunning && (
              <p className="mt-3 text-[12px] text-muted-foreground">Launch Docker Desktop, wait for it to say “running”, then Re-check.</p>
            )}
            <InstallerLog />
            <StepNav right={<Button variant="learn" onClick={next}>{dockerReady ? "Continue" : "Skip for now"}</Button>} />
          </StepBody>
        )}

        {step === 1 && (
          <StepBody
            icon={Server}
            title="Virtual machines"
            description="Some labs are full virtual machines (routers, Windows, multi-host networks). To run those, install one hypervisor and Vagrant. Skip this if you only want container labs."
          >
            {vmReady && <ReadyBanner>This machine can run VM labs.</ReadyBanner>}
            <div className="mt-1 space-y-4">
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Hypervisor <span className="font-normal normal-case text-muted-foreground/70">· one is enough</span></p>
                <div className="overflow-hidden rounded-lg border border-border">
                  {hypervisors.map((p) => (
                    <StatRow
                      key={p.provider}
                      name={providerLabel(p)}
                      ok={p.hypervisor === true}
                      detail={p.hypervisor === true ? "installed" : p.hypervisor === false ? "not installed" : "built in"}
                      action={p.hypervisor === false && p.provider === "virtualbox" ? <Install id="virtualbox" onClick={() => installDep("virtualbox", "Installing VirtualBox…")}>Install</Install> : undefined}
                    />
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Vagrant <span className="font-normal normal-case text-muted-foreground/70">· provisions the VMs</span></p>
                <div className="overflow-hidden rounded-lg border border-border">
                  <StatRow
                    name="Vagrant"
                    ok={report.vagrant.installed}
                    detail={toolText(report.vagrant)}
                    action={!report.vagrant.installed ? <Install id="vagrant" onClick={() => installDep("vagrant", "Installing Vagrant…")}>Install Vagrant</Install> : undefined}
                  />
                  {localPlugins.map((p) => (
                    <StatRow
                      key={p.provider}
                      name={providerLabel(p)}
                      mono={p.plugin}
                      ok={p.pluginInstalled}
                      detail={p.pluginInstalled ? "installed" : "not installed"}
                      action={report.vagrant.installed && !p.pluginInstalled && p.plugin ? <Install id={p.plugin} onClick={() => installPlugin(p.plugin!)}>Install</Install> : undefined}
                    />
                  ))}
                  {localPlugins.length === 0 && <p className="px-3.5 py-3 text-[12px] text-muted-foreground">Your installed hypervisors don’t need an extra Vagrant plugin.</p>}
                </div>
              </div>
            </div>
            <InstallerLog />
            <StepNav left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>} right={<Button variant="learn" onClick={next}>{vmReady ? "Continue" : "Skip"}</Button>} />
          </StepBody>
        )}

        {step === 2 && (
          <StepBody
            icon={Crosshair}
            title="Attack toolbox"
            description="You attack the lab targets from Exegol, an offensive toolbox that runs as its own container on the lab network, so your tools sit right next to the targets."
          >
            <div className="flex items-start gap-3 rounded-lg border border-learn/25 bg-learn/5 p-3.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-learn/30 bg-learn/10 text-learn">
                <Box className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">Exegol <span className="ml-1.5 rounded border border-border px-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">Soon</span></p>
                <p className="mt-1 text-[12px] text-muted-foreground">One-click Exegol provisioning is on the way. Until then, labs still run, attack them with your own tools against the exposed <span className="font-mono">127.0.0.1</span> ports shown in each lab’s network map.</p>
              </div>
            </div>
            <StepNav left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>} right={<Button variant="learn" onClick={next}>Continue</Button>} />
          </StepBody>
        )}

        {step === 3 && (
          <StepBody icon={Sparkles} title="You're set up" description="Here's what this machine can run. You can change any of it later from this page.">
            <div className="space-y-2.5">
              <SummaryRow ok={dockerReady} label="Container labs" value={dockerReady ? "Ready" : "Install Docker"} />
              <SummaryRow ok={vmReady} label="VM labs" value={vmReady ? "Ready" : "Optional, not set up"} muted={!vmReady} />
              <SummaryRow ok={false} label="Exegol attack box" value="Coming soon" muted />
            </div>
            <StepNav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => onRefresh()}><RefreshCw className="size-3.5" /> Re-check</Button>
                  <Button variant="learn" onClick={() => onNavigate("labs")} disabled={!dockerReady} title={dockerReady ? undefined : "Install Docker to run container labs"}>
                    <Play className="size-4" /> Browse labs
                  </Button>
                </div>
              }
            />
          </StepBody>
        )}
      </div>
    </div>
  );
}

function StepBody({ icon: Icon, title, description, children }: { icon: ComponentType<{ className?: string }>; title: string; description: string; children: ReactNode }) {
  return (
    <div className="p-5">
      <div className="flex items-start gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
          <Icon className="size-5 text-foreground" />
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

function StepNav({ left, right }: { left?: ReactNode; right: ReactNode }) {
  return (
    <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}
