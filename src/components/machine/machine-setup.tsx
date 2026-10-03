"use client";

import { useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Check, CheckCircle2, Container, Copy, Cpu, ExternalLink, Play, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { installDependency, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The guided "set up this machine" flow, shown in its own window. OS-aware: Windows gets
 *  the virtualization / WSL step that trips people up; macOS and Linux go straight to Docker. */
export function MachineSetup({ report, onRefresh, onClose }: { report: SystemReport | null; onRefresh: () => void; onClose: () => void }) {
  const os = report?.os ?? "";
  const isWin = os === "windows";
  const isMac = os === "macos";
  const steps: readonly string[] = isWin ? ["virtualization", "docker", "ready"] : ["docker", "ready"];
  const [i, setI] = useState(0);
  const key = steps[i];

  const [installing, setInstalling] = useState(false);
  const [installerOpened, setInstallerOpened] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
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

  function copy(text: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
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
        {key === "virtualization" && (
          <Step icon={Cpu} title="Enable virtualization (WSL 2)" description="Docker Desktop runs Linux containers through WSL 2. Turn it on once, this is the step most people miss on Windows.">
            <ol className="space-y-3">
              <Num n={1}>Open <b>PowerShell</b> as Administrator (right-click → “Run as administrator”).</Num>
              <Num n={2}>
                Run this, then reboot when it finishes:
                <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-border bg-[#070707] px-3 py-2">
                  <code className="flex-1 font-mono text-[12px] text-foreground">wsl --install</code>
                  <button onClick={() => copy("wsl --install")} className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">
                    {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
                  </button>
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
          <Step icon={Container} title="Install Docker" description={isMac ? "Container labs run on Docker Desktop. Install it in one click." : isWin ? "Now install Docker Desktop, it will use the WSL 2 you just enabled." : "Container labs run on Docker Engine."}>
            {dockerReady ? (
              <Ready>Docker is installed and running.</Ready>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[#0f0f0f] p-3.5">
                  <div>
                    <p className="text-[13px] font-medium">Docker {report?.docker.installed ? "isn’t running" : "isn’t installed"}</p>
                    <p className="text-[12px] text-muted-foreground">{report?.docker.installed ? "Launch Docker Desktop, then re-check." : "Opens Docker’s trusted installer."}</p>
                  </div>
                  {!installerOpened && !report?.docker.installed ? (
                    <Button variant="learn" onClick={installDocker} disabled={installing}>
                      {installing ? <><Spinner className="size-4" /> Installing…</> : "Install Docker"}
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => onRefresh()}><RefreshCw className="size-3.5" /> Re-check</Button>
                  )}
                </div>
                {installerOpened && <p className="text-[12px] text-muted-foreground">Finish in Docker’s installer, launch Docker Desktop, then press Re-check.</p>}
                {logs.length > 0 && (
                  <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-[#070707] p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                    {logs.join("\n")}
                    <div ref={logEnd} />
                  </pre>
                )}
              </div>
            )}
            <Nav
              left={isWin ? <Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button> : undefined}
              right={<Button variant="learn" onClick={next}>{dockerReady ? "Continue" : "Skip for now"}</Button>}
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
      </div>
    </div>
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

function Num({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium text-muted-foreground">{n}</span>
      <div className="min-w-0 text-[12.5px] leading-relaxed text-foreground">{children}</div>
    </li>
  );
}

function Ready({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
        <Check className="size-4" />
      </span>
      <p className="text-[13px] font-medium text-foreground">{children}</p>
    </div>
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
