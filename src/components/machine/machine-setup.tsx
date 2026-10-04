"use client";

import { useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Check, CheckCircle2, Container, Copy, Cpu, ExternalLink, Package, Play, RefreshCw, Server, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { installDependency, type Dependency, type DockerEngine, type SystemReport } from "@/lib/tauri";
import { DOWNLOAD, INSTALLABLE, providerLabel, usableHypervisors } from "@/lib/hypervisors";
import { cn } from "@/lib/utils";

/** The guided "set up this machine" flow, shown in its own window. OS-aware: Windows gets
 *  the virtualization / WSL step that trips people up; macOS and Linux go straight to Docker. */
export function MachineSetup({ report, onRefresh, onClose }: { report: SystemReport | null; onRefresh: () => void; onClose: () => void }) {
  const os = report?.os ?? "";
  const isWin = os === "windows";
  const isMac = os === "macos";
  const needsPkgMgr = !!report && !report.pkgManager.installed;
  const steps: readonly string[] = [
    ...(needsPkgMgr ? ["pkgmgr"] : []),
    ...(isWin ? ["virtualization"] : []),
    "docker",
    "vm",
    "ready",
  ];
  const [i, setI] = useState(0);
  const key = steps[Math.min(i, steps.length - 1)];
  const [vmBusy, setVmBusy] = useState<string | null>(null);

  const [installing, setInstalling] = useState(false);
  const [installerOpened, setInstallerOpened] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);

  const dockerReady = !!report && report.docker.installed && report.dockerRunning;
  const next = () => setI((n) => Math.min(n + 1, steps.length - 1));
  const back = () => setI((n) => Math.max(n - 1, 0));

  async function installDocker() {
    setInstalling(true);
    setLogs([]);
    try {
      await installDependency("docker", (line) => {
        setLogs((l) => [...l, line]);
        requestAnimationFrame(() => logEnd.current?.scrollIntoView({ block: "end" }));
      });
      setInstallerOpened(true);
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setInstalling(false);
      onRefresh();
    }
  }

  async function installVm(id: string, dep: Dependency, label: string) {
    setVmBusy(id);
    setLogs([`Installing ${label}…`]);
    try {
      await installDependency(dep, (line) => {
        setLogs((l) => [...l, line]);
        requestAnimationFrame(() => logEnd.current?.scrollIntoView({ block: "end" }));
      });
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setVmBusy(null);
      onRefresh();
    }
  }

  const osName = isWin ? "Windows" : isMac ? "macOS" : "Linux";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Set up this machine</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Get {osName} ready to run container labs, one step at a time.</p>
      </div>

      <div className="flex gap-1.5">
        {steps.map((_, n) => (
          <div key={n} className={cn("h-1 flex-1 rounded-full transition-colors", n <= i ? "bg-learn" : "bg-muted")} />
        ))}
      </div>

      <div key={key} className="animate-rise-in rounded-xl border border-border bg-card p-5">
        {!report ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner className="size-4" /> Checking this machine…</div>
        ) : (
        <>
        {key === "pkgmgr" && (
          <Step icon={Package} title={`Install ${report.pkgManager.name}`} description={`The one-click installs use ${report.pkgManager.name}. Set it up once and this guide picks it up automatically.`}>
            {isMac && (
              <div className="space-y-2">
                <p className="text-[12.5px] text-muted-foreground">Run this in Terminal, then come back, it’s detected automatically:</p>
                <CmdRow cmd={'/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'} />
                <button onClick={() => openUrl("https://brew.sh").catch(() => {})} className="inline-flex items-center gap-1.5 text-[12px] text-learn hover:underline"><ExternalLink className="size-3.5" /> brew.sh</button>
              </div>
            )}
            {isWin && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[#0f0f0f] p-3.5">
                <div><p className="text-[13px] font-medium">App Installer (winget)</p><p className="text-[12px] text-muted-foreground">Install it from the Microsoft Store, then come back.</p></div>
                <Button variant="learn" onClick={() => openUrl("https://apps.microsoft.com/detail/9nblggh4nns1").catch(() => {})}><ExternalLink className="size-3.5" /> Get</Button>
              </div>
            )}
            {!isMac && !isWin && <p className="text-[12.5px] text-muted-foreground">Install your distribution’s package manager (apt) to use the one-click installs.</p>}
            <Nav right={<Button variant="learn" onClick={next}>Continue</Button>} />
          </Step>
        )}
        {key === "virtualization" && (
          <Step icon={Cpu} title="Enable virtualization (WSL 2)" description="Docker Desktop runs Linux containers through WSL 2. Turn it on once, this is the step most people miss on Windows.">
            <ol className="space-y-3">
              <Num n={1}>Open <b>PowerShell</b> as Administrator (right-click → “Run as administrator”).</Num>
              <Num n={2}>
                Run this, then reboot when it finishes:
                <div className="mt-1.5">
                  <CmdRow cmd="wsl --install" />
                </div>
              </Num>
              <Num n={3}>
                If Docker later says virtualization is off: open “Turn Windows features on or off” and enable <b>Virtual Machine Platform</b> and <b>Windows Subsystem for Linux</b>, and make sure virtualization is enabled in your BIOS/UEFI.
              </Num>
            </ol>
            <button onClick={() => openUrl("https://learn.microsoft.com/windows/wsl/install").catch(() => {})} className="mt-4 inline-flex items-center gap-1.5 text-[12px] text-learn hover:underline">
              <ExternalLink className="size-3.5" /> Microsoft’s WSL install guide
            </button>
            <Nav right={<Button variant="learn" onClick={next}>I’ve done this</Button>} />
          </Step>
        )}

        {key === "docker" && (
          <Step icon={Container} title="Container engine" description={isWin ? "Container labs need a Docker-compatible engine (it uses the WSL 2 you enabled). Pick any of these." : "Container labs need a Docker-compatible engine. Pick any of these, they all work."}>
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border border-border">
                {ENGINES.filter((e) => e.os.includes(os)).map((e) => {
                  const inUse = report.dockerEngine === e.id;
                  const primary = e.id === (isMac || isWin ? "docker-desktop" : "docker-engine");
                  return (
                    <div key={e.id} className={cn("flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0", inUse && "bg-emerald-500/[0.06]")}>
                      <EngineLogo engine={e} />
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                          {e.name}
                          {primary && !inUse && <span className="rounded border border-border px-1.5 py-px text-[10.5px] font-normal text-muted-foreground">Recommended</span>}
                        </p>
                        <p className="text-[12px] text-muted-foreground">{e.note}</p>
                      </div>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        {inUse ? (
                          <span className="flex items-center gap-1.5 text-[12px] text-emerald-500"><span className="size-1.5 rounded-full bg-emerald-500" /> In use</span>
                        ) : primary && !report.docker.installed ? (
                          !installerOpened ? (
                            <Button variant="learn" size="sm" onClick={installDocker} disabled={installing}>
                              {installing ? <><Spinner className="size-3.5" /> Installing…</> : "Install"}
                            </Button>
                          ) : (
                            <Button variant="outline" size="sm" onClick={() => onRefresh()}><RefreshCw className="size-3.5" /> Re-check</Button>
                          )
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => openUrl(e.url).catch(() => {})}><ExternalLink className="size-3.5" /> Get</Button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              {!dockerReady && report.docker.installed ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3.5">
                  <p className="text-[12.5px] text-foreground">An engine is installed but not running. Start it, then re-check.</p>
                  <Button variant="outline" size="sm" onClick={() => onRefresh()}><RefreshCw className="size-3.5" /> Re-check</Button>
                </div>
              ) : null}
              {!dockerReady && installerOpened && <p className="text-[12px] text-muted-foreground">Finish in Docker’s installer, launch Docker Desktop, then press Re-check.</p>}
              {!dockerReady && isWin && <p className="text-[12px] text-muted-foreground">A reboot may be needed after enabling WSL. If Docker says virtualization is off, go back a step.</p>}
              {!dockerReady && !isMac && !isWin && (
                <div className="space-y-2 rounded-lg border border-border bg-[#0f0f0f] p-3 text-[12px] text-muted-foreground">
                  <p>After Docker Engine installs, let your user run it and start the service:</p>
                  <CmdRow cmd="sudo usermod -aG docker $USER" />
                  <CmdRow cmd="sudo systemctl enable --now docker" />
                  <p>Then log out and back in.</p>
                </div>
              )}
              {logs.length > 0 && (
                <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-[#070707] p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                  {logs.join("\n")}
                  <div ref={logEnd} />
                </pre>
              )}
            </div>
            <div className="mt-4"><EngineTrademarks /></div>
            <Nav
              left={isWin ? <Button variant="outline" onClick={back} disabled={installing}><ArrowLeft className="size-4" /> Back</Button> : undefined}
              right={<Button variant="learn" onClick={next} disabled={installing}>{dockerReady ? "Continue" : "Skip for now"}</Button>}
            />
          </Step>
        )}

        {key === "vm" && (
          <Step icon={Server} title="Virtual machines" description="Labs built from full VMs (Active Directory domains, Windows hosts, routers, multi-host networks) need a hypervisor. You can also add one later from the Machine page.">
            {report && usableHypervisors(report).length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-border">
                {usableHypervisors(report).map((p) => (
                  <div key={p.provider} className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
                    <span className="text-foreground">{providerLabel(p)}</span>
                    <span className={cn("ml-auto flex items-center gap-1.5", p.hypervisor === true ? "text-emerald-500" : "text-muted-foreground")}>
                      {p.hypervisor === true && <span className="size-1.5 rounded-full bg-emerald-500" />}
                      {p.hypervisor === true ? "installed" : "not installed"}
                      {p.hypervisor !== true && INSTALLABLE[p.provider] && (
                        <Button variant="learn" size="sm" onClick={() => installVm(p.provider, INSTALLABLE[p.provider]!, providerLabel(p))} disabled={vmBusy !== null}>
                          {vmBusy === p.provider ? "Installing…" : "Install"}
                        </Button>
                      )}
                      {p.hypervisor !== true && !INSTALLABLE[p.provider] && DOWNLOAD[p.provider] && (
                        <Button variant="outline" size="sm" onClick={() => openUrl(DOWNLOAD[p.provider]!).catch(() => {})}><ExternalLink className="size-3.5" /> Get</Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">No local hypervisor applies to this machine. You can run VM labs on a Server (ESXi / Proxmox) instead.</p>
            )}
            {logs.length > 0 && (
              <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-border bg-[#070707] p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                {logs.join("\n")}
                <div ref={logEnd} />
              </pre>
            )}
            <Nav
              left={<Button variant="outline" onClick={back} disabled={vmBusy !== null}><ArrowLeft className="size-4" /> Back</Button>}
              right={<Button variant="learn" onClick={next} disabled={vmBusy !== null}>Continue</Button>}
            />
          </Step>
        )}

        {key === "ready" && (
          <Step icon={Sparkles} title="You’re set up" description="You can run this guide again anytime from the Machine page.">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-[#0f0f0f] p-3.5">
              <span className={cn("flex size-7 items-center justify-center rounded-full", dockerReady ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground")}>
                <CheckCircle2 className="size-4" />
              </span>
              <div>
                <p className="text-[13px] font-medium">Container labs</p>
                <p className="text-[12px] text-muted-foreground">{dockerReady ? "Ready to run." : "Install Docker to run them."}</p>
              </div>
            </div>
            <Nav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={<Button variant="learn" onClick={onClose}><Play className="size-4" /> Done</Button>}
            />
          </Step>
        )}
        </>
        )}
      </div>
    </div>
  );
}

/** Docker-compatible engines, per OS. The recommended one gets the one-click install; others link out. */
type Engine = { id: DockerEngine; name: string; note: string; url: string; os: string[]; logo: string; tile?: boolean };
const ENGINES: Engine[] = [
  { id: "docker-desktop", name: "Docker Desktop", note: "The official app. Easiest to set up.", url: "https://www.docker.com/products/docker-desktop/", os: ["macos", "windows", "linux"], logo: "/brands/docker.svg" },
  { id: "docker-engine", name: "Docker Engine", note: "The native daemon, no desktop app.", url: "https://docs.docker.com/engine/install/", os: ["linux"], logo: "/brands/docker.svg" },
  { id: "orbstack", name: "OrbStack", note: "Fast and light on memory. Free for personal use.", url: "https://orbstack.dev/", os: ["macos"], logo: "/brands/orbstack.png", tile: true },
  { id: "colima", name: "Colima", note: "Open source, command line only.", url: "https://github.com/abiosoft/colima", os: ["macos", "linux"], logo: "/brands/colima.png" },
  { id: "rancher-desktop", name: "Rancher Desktop", note: "Open source. Choose the dockerd (moby) engine.", url: "https://rancherdesktop.io/", os: ["macos", "windows", "linux"], logo: "/brands/rancher-desktop.svg", tile: true },
];

/** Brand mark in a fixed square. App icons (`tile`) fill it; bare marks sit on a light chip so dark artwork stays legible. */
function EngineLogo({ engine }: { engine: Engine }) {
  return engine.tile ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={engine.logo} alt="" className="size-8 shrink-0 rounded-lg object-contain" />
  ) : (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white p-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={engine.logo} alt="" className="size-full object-contain" />
    </span>
  );
}

/** Trademark notice for the engine marks shown above. */
function EngineTrademarks() {
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground/70">
      Docker and the Docker logo are trademarks of Docker, Inc. OrbStack, Colima and Rancher Desktop marks belong to their respective owners. CyberCTF isn&apos;t affiliated with any of them.
    </p>
  );
}

function Step({ icon: Icon, title, description, children }: { icon: typeof Cpu; title: string; description: string; children: React.ReactNode }) {
  return (
    <div>
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

function CmdRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-[#070707] px-3 py-2">
      <code className="flex-1 overflow-x-auto font-mono text-[12px] text-foreground">{cmd}</code>
      <button
        onClick={() =>
          navigator.clipboard
            ?.writeText(cmd)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => {})
        }
        className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Num({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium text-muted-foreground">{n}</span>
      <div className="min-w-0 text-[12.5px] leading-relaxed text-foreground">{children}</div>
    </li>
  );
}

function Nav({ left, right }: { left?: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}
