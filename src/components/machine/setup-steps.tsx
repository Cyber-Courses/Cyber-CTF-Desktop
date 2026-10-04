"use client";

/**
 * The machine-setup steps, shared by the "Set up this machine" window and the first-run
 * onboarding. Each flow owns its own frame (header style, progress, nav buttons); the step
 * list, titles, bodies and install/test state all live here, so a change shows up in both.
 */

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CheckCircle2,
  Container,
  Copy,
  Cpu,
  Crosshair,
  ExternalLink,
  FlaskConical,
  Package,
  RefreshCw,
  Server,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SelfTest, type SelfTestResult } from "@/components/machine/self-test";
import { ATTACK_PRESETS, DEFAULT_ATTACK_IMAGE, getAttackImage, getAutoAttackBox, getVmProvider, setAttackImage, setAutoAttackBox } from "@/lib/settings";
import {
  dockerUseEngine,
  installDependency,
  installVagrantPlugin,
  machineSelftestPrefetch,
  type Dependency,
  type DockerEngine,
  type SystemReport,
} from "@/lib/tauri";
import { DOWNLOAD, INSTALLABLE, providerLabel, usableHypervisors } from "@/lib/hypervisors";
import { cn } from "@/lib/utils";

export type MachineStep = "pkgmgr" | "virtualization" | "docker" | "docker-test" | "attack" | "vm" | "vagrant" | "vm-test";

/** The steps this machine needs, in order. OS-aware: Windows gets the WSL step. */
export function machineSteps(report: SystemReport | null): MachineStep[] {
  return ["pkgmgr", ...(report?.os === "windows" ? (["virtualization"] as const) : []), "docker", "docker-test", "attack", "vm", "vagrant", "vm-test"];
}

const isDockerReady = (r: SystemReport | null) => !!r && r.docker.installed && r.dockerRunning;
const hasHypervisor = (r: SystemReport | null) => !!r && usableHypervisors(r).some((p) => p.hypervisor === true);

export function stepMeta(step: MachineStep, report: SystemReport | null): { icon: LucideIcon; title: string; description: string } {
  const pm = report?.pkgManager.name ?? "a package manager";
  switch (step) {
    case "pkgmgr":
      return {
        icon: Package,
        title: "Setup tools",
        description: `Cyber CTF installs everything else for you through ${pm}, your system's package manager. It only has to be set up once.`,
      };
    case "virtualization":
      return {
        icon: Cpu,
        title: "Enable virtualization (WSL 2)",
        description: "Docker Desktop runs Linux containers through WSL 2. Turn it on once, this is the step most people miss on Windows.",
      };
    case "docker":
      return {
        icon: Container,
        title: "Container engine",
        description:
          report?.os === "windows"
            ? "Container labs need one Docker-compatible engine (it uses the WSL 2 you enabled). Pick the one you prefer."
            : "Container labs need one Docker-compatible engine. Pick the one you prefer, they all work.",
      };
    case "attack":
      return {
        icon: Crosshair,
        title: "Attack machine",
        description:
          "The machine you attack labs from: a container that starts next to each lab, on its network. Pick a toolset; you can change it later in Settings.",
      };
    case "vm":
      return {
        icon: Server,
        title: "Virtual machines",
        description:
          "Labs built from full VMs (Active Directory domains, Windows hosts, routers, multi-host networks) need one hypervisor, whichever you prefer. You can also add one later from the Machine page.",
      };
    case "vagrant":
      return {
        icon: Package,
        title: "Provisioning",
        description:
          "Cyber CTF creates and starts each lab's virtual machines with Vagrant, a free tool, on your hypervisor. Most hypervisors also need a small add-on (plugin) for it.",
      };
    case "docker-test":
      return {
        icon: FlaskConical,
        title: "Test container labs",
        description: "Starts a tiny two-container lab, checks it works, then deletes it. About 2 MB to download.",
      };
    case "vm-test":
      return {
        icon: FlaskConical,
        title: "Test VM labs",
        description: "Boots a real test VM, checks it works, then deletes it. Takes a few minutes; the first run downloads a small VM image (cached after).",
      };
  }
}

/** Install + test state for the setup steps. One per flow, passed to every step body.
 *  Starts each test's download in the background as soon as the machine can run it. */
export function useMachineSetup(report: SystemReport | null, onRefresh: () => void) {
  const prefetched = useRef({ docker: false, vm: false });
  const dockerReady = isDockerReady(report);
  const vmReady = hasHypervisor(report) && !!report?.vagrant.installed;
  useEffect(() => {
    if (dockerReady && !prefetched.current.docker) {
      prefetched.current.docker = true;
      machineSelftestPrefetch("docker", null).catch(() => {});
    }
    if (vmReady && !prefetched.current.vm) {
      prefetched.current.vm = true;
      machineSelftestPrefetch("vm", getVmProvider()).catch(() => {});
    }
  }, [dockerReady, vmReady]);

  const [installing, setInstalling] = useState<string | null>(null);
  const [installerOpened, setInstallerOpened] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [dockerTest, setDockerTest] = useState<SelfTestResult>("idle");
  const [vmTest, setVmTest] = useState<SelfTestResult>("idle");
  // The option the player picked on the engine / hypervisor steps (null = not picked yet).
  const [engine, setEngine] = useState<DockerEngine | null>(null);
  const [hypervisor, setHypervisor] = useState<string | null>(null);
  async function install(id: string, dep: Dependency, first: string) {
    setInstalling(id);
    setLogs([first]);
    try {
      await installDependency(dep, (line) => setLogs((l) => [...l, line]));
      if (dep === "docker") setInstallerOpened(true);
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setInstalling(null);
      onRefresh();
    }
  }

  /** Adds the Vagrant plugin a hypervisor needs (e.g. vagrant-vmware-desktop). */
  async function installPlugin(plugin: string) {
    setInstalling(plugin);
    setLogs([`Installing the Vagrant plugin ${plugin}…`]);
    try {
      await installVagrantPlugin(plugin, (line) => setLogs((l) => [...l, line]));
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setInstalling(null);
      onRefresh();
    }
  }

  return {
    installing,
    installerOpened,
    installPlugin,
    logs,
    dockerTest,
    setDockerTest,
    vmTest,
    setVmTest,
    install,
    onRefresh,
    engine,
    setEngine,
    hypervisor,
    setHypervisor,
    /** Something is running: the flow should not move to another step. */
    busy: installing !== null || dockerTest === "running" || vmTest === "running",
  };
}
export type MachineSetupState = ReturnType<typeof useMachineSetup>;

/** Label for the flow's forward button on this step. */
export function nextLabel(step: MachineStep, report: SystemReport | null): string {
  if (step === "virtualization") return "I’ve done this";
  if (step === "vm-test" && !hasHypervisor(report)) return "Skip for now";
  return "Continue";
}

/** The engine the player picked, else the one in use (it can be reported after the step
 *  first shows), else the recommended one for this OS. */
export function chosenEngine(report: SystemReport, setup: MachineSetupState): Engine {
  const engines = ENGINES.filter((e) => e.os.includes(report.os));
  const recommended = report.os === "macos" || report.os === "windows" ? "docker-desktop" : "docker-engine";
  return engines.find((e) => e.id === (setup.engine ?? report.dockerEngine ?? recommended)) ?? engines[0];
}

/** The hypervisor the player picked, else an installed one, else the first Cyber CTF can install. */
export function chosenHypervisor(report: SystemReport, setup: MachineSetupState) {
  const hypervisors = usableHypervisors(report);
  const fallback = hypervisors.find((p) => p.hypervisor === true) ?? hypervisors.find((p) => INSTALLABLE[p.provider]) ?? hypervisors[0];
  return hypervisors.find((p) => p.provider === (setup.hypervisor ?? fallback?.provider)) ?? fallback;
}

/** The flow moves on only once the option picked on this step is actually set up. */
export function canContinue(step: MachineStep, report: SystemReport | null, setup: MachineSetupState): boolean {
  if (!report) return false;
  if (step === "pkgmgr") return report.pkgManager.installed;
  if (step === "docker") return isDockerReady(report) && report.dockerEngine === chosenEngine(report, setup).id;
  if (step === "vm") {
    const choice = chosenHypervisor(report, setup);
    // No local hypervisor applies here (VM labs go to a Server): nothing to wait for.
    return !choice || choice.hypervisor === true;
  }
  if (step === "vagrant") {
    const choice = chosenHypervisor(report, setup);
    // No local hypervisor (VM labs go to a Server): nothing for Vagrant to drive here.
    if (!choice) return true;
    // Vagrant, and the plugin that lets it drive the chosen hypervisor.
    return report.vagrant.installed && (!choice.plugin || choice.pluginInstalled);
  }
  return true;
}

/** The body of one setup step (no header, no nav: the flow draws those). */
export function MachineStepBody({ step, report, setup }: { step: MachineStep; report: SystemReport; setup: MachineSetupState }) {
  const isWin = report.os === "windows";
  const isMac = report.os === "macos";

  if (step === "pkgmgr") {
    if (report.pkgManager.installed) {
      return (
        <div className="overflow-hidden rounded-lg border border-border">
          <Requirement ok title={report.pkgManager.name} detail={report.pkgManager.version ?? "Installed"} action={null} />
        </div>
      );
    }
    return (
      <>
        {isMac && (
          <div className="space-y-2">
            <p className="text-[12.5px] text-muted-foreground">Run this in Terminal, then come back, it’s detected automatically:</p>
            <CmdRow cmd={'/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'} />
            <button
              onClick={() => openUrl("https://brew.sh").catch(() => {})}
              className="inline-flex items-center gap-1.5 text-[12px] text-learn hover:underline"
            >
              <ExternalLink className="size-3.5" /> brew.sh
            </button>
          </div>
        )}
        {isWin && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[#0f0f0f] p-3.5">
            <div>
              <p className="text-[13px] font-medium">App Installer (winget)</p>
              <p className="text-[12px] text-muted-foreground">Install it from the Microsoft Store, then come back.</p>
            </div>
            <Button variant="learn" onClick={() => openUrl("https://apps.microsoft.com/detail/9nblggh4nns1").catch(() => {})}>
              <ExternalLink className="size-3.5" /> Get
            </Button>
          </div>
        )}
        {!isMac && !isWin && (
          <p className="text-[12.5px] text-muted-foreground">Install your distribution’s package manager (apt) to use the one-click installs.</p>
        )}
      </>
    );
  }

  if (step === "virtualization") {
    return (
      <>
        <ol className="space-y-3">
          <Num n={1}>
            Open <b>PowerShell</b> as Administrator (right-click → “Run as administrator”).
          </Num>
          <Num n={2}>
            Run this, then reboot when it finishes:
            <div className="mt-1.5">
              <CmdRow cmd="wsl --install" />
            </div>
          </Num>
          <Num n={3}>
            If Docker later says virtualization is off: open “Turn Windows features on or off” and enable <b>Virtual Machine Platform</b> and{" "}
            <b>Windows Subsystem for Linux</b>, and make sure virtualization is enabled in your BIOS/UEFI.
          </Num>
        </ol>
        <button
          onClick={() => openUrl("https://learn.microsoft.com/windows/wsl/install").catch(() => {})}
          className="mt-4 inline-flex items-center gap-1.5 text-[12px] text-learn hover:underline"
        >
          <ExternalLink className="size-3.5" /> Microsoft’s WSL install guide
        </button>
      </>
    );
  }

  if (step === "docker") return <EngineStep report={report} setup={setup} />;
  if (step === "attack") return <AttackStep report={report} />;
  if (step === "vm") return <VmStep report={report} setup={setup} />;
  if (step === "vagrant") return <VagrantStep report={report} setup={setup} />;

  if (step === "docker-test") {
    return isDockerReady(report) ? (
      <SelfTest kind="docker" title="Container lab test" description="busybox, two containers on a lab network." auto onResult={setup.setDockerTest} />
    ) : (
      <Skipped title="Nothing to test yet" reason="No container engine is running. Go back to set one up, or skip for now." />
    );
  }

  return hasHypervisor(report) ? (
    <SelfTest kind="vm" title="VM lab test" description="Boots, runs a command, pings it on a lab network, deletes it." auto onResult={setup.setVmTest} />
  ) : (
    <Skipped title="Nothing to test yet" reason="No hypervisor is installed. Go back to install one, or skip for now." />
  );
}

/** End-of-setup summary: what this machine can run, from the test results. */
export function SetupOutcome({ report, setup }: { report: SystemReport | null; setup: MachineSetupState }) {
  const { dockerTest, vmTest } = setup;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Outcome
        title="Container labs"
        ok={dockerTest === "ok"}
        detail={
          dockerTest === "ok"
            ? "Tested and ready to run."
            : dockerTest === "fail"
              ? "The test failed. Go back to run it again."
              : isDockerReady(report)
                ? "Engine running, not tested."
                : "Set up a container engine to run them."
        }
      />
      <Outcome
        title="VM labs"
        ok={vmTest === "ok"}
        detail={
          vmTest === "ok"
            ? "Tested and ready to run."
            : vmTest === "fail"
              ? "The test failed. Go back to run it again."
              : hasHypervisor(report)
                ? "Not tested."
                : "Install a hypervisor to run them."
        }
      />
    </div>
  );
}

// ---------- Container engine ----------

type Engine = { id: DockerEngine; name: string; note: string; url: string; os: string[]; logo: string; tile?: boolean };
/** Docker-compatible engines, per OS. The recommended one gets the one-click install; others link out. */
const ENGINES: Engine[] = [
  {
    id: "docker-desktop",
    name: "Docker Desktop",
    note: "The official app. Easiest to set up.",
    url: "https://www.docker.com/products/docker-desktop/",
    os: ["macos", "windows", "linux"],
    logo: "/brands/docker.svg",
  },
  {
    id: "docker-engine",
    name: "Docker Engine",
    note: "The native daemon, no desktop app.",
    url: "https://docs.docker.com/engine/install/",
    os: ["linux"],
    logo: "/brands/docker.svg",
  },
  {
    id: "orbstack",
    name: "OrbStack",
    note: "Fast and light on memory. Free for personal use.",
    url: "https://orbstack.dev/",
    os: ["macos"],
    logo: "/brands/orbstack.png",
    tile: true,
  },
  {
    id: "colima",
    name: "Colima",
    note: "Open source, command line only.",
    url: "https://github.com/abiosoft/colima",
    os: ["macos", "linux"],
    logo: "/brands/colima.png",
  },
];

function EngineStep({ report, setup }: { report: SystemReport; setup: MachineSetupState }) {
  const isWin = report.os === "windows";
  const isMac = report.os === "macos";
  const ready = isDockerReady(report);
  const { installing, installerOpened, install, onRefresh } = setup;
  const engines = ENGINES.filter((e) => e.os.includes(report.os));
  const recommended = isMac || isWin ? "docker-desktop" : "docker-engine";
  // One engine is enough; the pick lives in the setup state so the flow can wait for it.
  const choice = chosenEngine(report, setup);
  // Several engines can run at once; Docker talks to one. Switching = `docker context use`.
  const [switching, setSwitching] = useState(false);
  const switchTo = (engine: DockerEngine) => {
    setSwitching(true);
    dockerUseEngine(engine)
      .catch(() => {})
      .finally(() => {
        setSwitching(false);
        onRefresh();
      });
  };
  const inUse = report.dockerEngine === choice.id;
  return (
    <div className="space-y-3">
      <ChoiceGrid>
        {engines.map((e) => (
          <Choice
            key={e.id}
            selected={e.id === choice.id}
            onSelect={() => setup.setEngine(e.id)}
            mark={<EngineLogo engine={e} />}
            title={e.name}
            note={e.note}
            badge={
              report.dockerEngine === e.id
                ? "in use"
                : report.dockerEnginesRunning?.includes(e.id)
                  ? "running"
                  : e.id === recommended
                    ? "recommended"
                    : undefined
            }
          />
        ))}
      </ChoiceGrid>
      {/* Only when there is something to do: an engine in use already says so on its card. */}
      {!inUse && (
        <ChoiceAction>
          {report.dockerEnginesRunning?.includes(choice.id) ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">
                {choice.name} is running, but Docker uses {engines.find((e) => e.id === report.dockerEngine)?.name ?? "another engine"} right now.
              </span>
              <Button variant="learn" size="sm" disabled={switching} onClick={() => switchTo(choice.id)}>
                {switching ? (
                  <>
                    <Spinner className="size-3.5" /> Switching…
                  </>
                ) : (
                  `Use ${choice.name}`
                )}
              </Button>
            </>
          ) : choice.id === recommended && !report.docker.installed ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Cyber CTF can install {choice.name} for you.</span>
              {!installerOpened ? (
                <Button
                  variant="learn"
                  size="sm"
                  onClick={() => install("docker", "docker", "Installing the container engine…")}
                  disabled={installing !== null}
                >
                  {installing === "docker" ? (
                    <>
                      <Spinner className="size-3.5" /> Installing…
                    </>
                  ) : (
                    `Install ${choice.name}`
                  )}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Install {choice.name}, start it, then re-check.</span>
              <span className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => openUrl(choice.url).catch(() => {})}>
                  <ExternalLink className="size-3.5" /> Get {choice.name}
                </Button>
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
              </span>
            </>
          )}
        </ChoiceAction>
      )}
      {!ready && report.docker.installed && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3.5 text-left">
          <p className="text-[12.5px] text-foreground">An engine is installed but not running. Start it, then re-check.</p>
          <Button variant="outline" size="sm" onClick={() => onRefresh()}>
            <RefreshCw className="size-3.5" /> Re-check
          </Button>
        </div>
      )}
      {!ready && installerOpened && (
        <p className="text-[12px] text-muted-foreground">Finish in Docker’s installer, launch Docker Desktop, then press Re-check.</p>
      )}
      {!ready && isWin && (
        <p className="text-[12px] text-muted-foreground">A reboot may be needed after enabling WSL. If Docker says virtualization is off, go back a step.</p>
      )}
      {!ready && !isMac && !isWin && choice.id === "docker-engine" && (
        <div className="space-y-2 rounded-lg border border-border bg-[#0f0f0f] p-3 text-left text-[12px] text-muted-foreground">
          <p>After Docker Engine installs, let your user run it and start the service:</p>
          <CmdRow cmd="sudo usermod -aG docker $USER" />
          <CmdRow cmd="sudo systemctl enable --now docker" />
          <p>Then log out and back in.</p>
        </div>
      )}
      <Log setup={setup} />
      <EngineTrademarks />
    </div>
  );
}

/** Brand mark in a fixed square. App icons (`tile`) fill it; bare marks sit on a light chip so dark artwork stays legible. */
/** The logo of a Docker-compatible engine, for other screens (e.g. the Machine page). */
export function EngineMark({ id }: { id: DockerEngine }) {
  const e = ENGINES.find((x) => x.id === id);
  return e ? <EngineLogo engine={e} /> : null;
}

/** Display name of a Docker-compatible engine. */
export const engineName = (id: DockerEngine) => (id === "podman" ? "Podman" : (ENGINES.find((e) => e.id === id)?.name ?? "Docker"));

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

function EngineTrademarks() {
  return (
    <p className="pt-1 text-left text-[11px] leading-relaxed text-muted-foreground/70">
      Docker and the Docker logo are trademarks of Docker, Inc. OrbStack and Colima marks belong to their respective owners. Cyber CTF isn&apos;t affiliated
      with any of them.
    </p>
  );
}

// ---------- Virtual machines ----------

// ---------- Attack machine ----------

/** Pick the attack box image (same setting as Settings → Attack box) and whether it starts with each lab. */
function AttackStep({ report }: { report: SystemReport }) {
  const [image, setImage] = useState(() => getAttackImage());
  const [auto, setAuto] = useState(() => getAutoAttackBox());
  const presets = ATTACK_PRESETS;
  const custom = !presets.some((p) => p.image === image);
  const pick = (img: string) => {
    setAttackImage(img);
    setImage(img);
  };
  return (
    <div className="space-y-3">
      <ChoiceGrid>
        {presets.map((p) => (
          <Choice
            key={p.image}
            selected={image === p.image}
            onSelect={() => pick(p.image)}
            mark={
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
                <Terminal className="size-4 text-muted-foreground" />
              </span>
            }
            title={p.label}
            note={[p.note, p.large ? "large download" : null, p.terms].filter(Boolean).join(" · ")}
            badge={p.image === DEFAULT_ATTACK_IMAGE ? "recommended" : undefined}
          />
        ))}
      </ChoiceGrid>
      {custom && (
        <p className="text-left text-[12px] text-muted-foreground">
          Using a custom image from Settings: <span className="font-mono">{image}</span>
        </p>
      )}
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left">
        <span>
          <span className="block text-[13px] font-medium">Start it with each lab</span>
          <span className="block text-[12px] text-muted-foreground">Otherwise launch it from the lab’s page when you need it.</span>
        </span>
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAutoAttackBox(e.target.checked);
            setAuto(e.target.checked);
          }}
          className="size-4 accent-[var(--color-learn)]"
        />
      </label>
      {!isDockerReady(report) && (
        <p className="text-left text-[12px] text-muted-foreground">It runs on your container engine, so it works once one is set up.</p>
      )}
      <p className="text-left text-[12px] text-muted-foreground">The image downloads the first time a lab starts it.</p>
    </div>
  );
}

function VmStep({ report, setup }: { report: SystemReport; setup: MachineSetupState }) {
  const hypervisors = usableHypervisors(report);
  const { installing, install, onRefresh } = setup;
  // One hypervisor is enough; the pick lives in the setup state so the flow can wait for it.
  const picked = chosenHypervisor(report, setup);
  if (hypervisors.length === 0) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        No local hypervisor applies to this machine. You can run VM labs on a Server (ESXi / Proxmox) instead.
      </p>
    );
  }
  const choice = picked ?? hypervisors[0];
  const label = providerLabel(choice);
  return (
    <div className="space-y-3">
      <ChoiceGrid>
        {hypervisors.map((p) => (
          <Choice
            key={p.provider}
            selected={p.provider === choice.provider}
            onSelect={() => setup.setHypervisor(p.provider)}
            mark={
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Server className="size-4" />
              </span>
            }
            title={providerLabel(p)}
            note={INSTALLABLE[p.provider] ? "Cyber CTF can install it for you." : "Install it from the vendor's site."}
            badge={p.hypervisor === true ? "installed" : undefined}
          />
        ))}
      </ChoiceGrid>
      {/* Only when there is something to do: an installed hypervisor says so on its card. */}
      {choice.hypervisor !== true && (
        <ChoiceAction>
          {INSTALLABLE[choice.provider] ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Cyber CTF can install {label} for you.</span>
              <Button
                variant="learn"
                size="sm"
                onClick={() => install(choice.provider, INSTALLABLE[choice.provider]!, `Installing ${label}…`)}
                disabled={installing !== null}
              >
                {installing === choice.provider ? (
                  <>
                    <Spinner className="size-3.5" /> Installing…
                  </>
                ) : (
                  `Install ${label}`
                )}
              </Button>
            </>
          ) : (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Install {label}, then re-check.</span>
              <span className="flex shrink-0 gap-2">
                {DOWNLOAD[choice.provider] && (
                  <Button variant="outline" size="sm" onClick={() => openUrl(DOWNLOAD[choice.provider]!).catch(() => {})}>
                    <ExternalLink className="size-3.5" /> Get {label}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
              </span>
            </>
          )}
        </ChoiceAction>
      )}
      <Log setup={setup} />
    </div>
  );
}

function VagrantStep({ report, setup }: { report: SystemReport; setup: MachineSetupState }) {
  const choice = chosenHypervisor(report, setup);
  const { installing, install } = setup;
  if (!choice) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        No local hypervisor applies to this machine, so there is nothing for Vagrant to drive here. VM labs can run on a Server instead.
      </p>
    );
  }
  const label = providerLabel(choice);
  return (
    <div className="space-y-3">
      {/* For the hypervisor picked on the previous step. */}
      <div className="overflow-hidden rounded-lg border border-border">
        <Requirement
          ok={report.vagrant.installed}
          title="Vagrant"
          detail={report.vagrant.installed ? (report.vagrant.version ?? "Installed") : "Creates and starts the lab VMs."}
          action={
            <Button variant="learn" size="sm" onClick={() => install("vagrant", "vagrant", "Installing Vagrant…")} disabled={installing !== null}>
              {installing === "vagrant" ? (
                <>
                  <Spinner className="size-3.5" /> Installing…
                </>
              ) : (
                "Install Vagrant"
              )}
            </Button>
          }
        />
        {choice.plugin && (
          <Requirement
            ok={choice.pluginInstalled}
            title={`${label} add-on for Vagrant`}
            detail={choice.pluginInstalled || report.vagrant.installed ? choice.plugin : `${choice.plugin}, once Vagrant is installed.`}
            action={
              <Button variant="learn" size="sm" onClick={() => setup.installPlugin(choice.plugin!)} disabled={installing !== null || !report.vagrant.installed}>
                {installing === choice.plugin ? (
                  <>
                    <Spinner className="size-3.5" /> Installing…
                  </>
                ) : (
                  "Install plugin"
                )}
              </Button>
            }
          />
        )}
        {choice.provider === "vmware_desktop" && (
          <Requirement
            ok={false}
            optional
            title="Vagrant VMware Utility"
            detail="HashiCorp's helper service the VMware plugin talks to. Install it once."
            action={
              <Button variant="outline" size="sm" onClick={() => openUrl("https://developer.hashicorp.com/vagrant/install/vmware").catch(() => {})}>
                <ExternalLink className="size-3.5" /> Get
              </Button>
            }
          />
        )}
      </div>
      <Log setup={setup} />
    </div>
  );
}

/** One thing the step needs: done (with a check), or its install action. `optional` rows
 *  can't be detected, so they always show their action and never block the flow. */
export function Requirement({
  ok,
  title,
  detail,
  action,
  optional,
}: {
  ok: boolean;
  title: string;
  detail: string;
  action: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {ok ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <span className={cn("size-1.5 rounded-full", optional ? "bg-muted-foreground/40" : "bg-amber-500")} />
        )}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[0.8125rem] text-foreground">{title}</span>
        <span className="block break-words font-mono text-[0.6875rem] text-muted-foreground">{detail}</span>
      </span>
      {!ok && <span className="shrink-0">{action}</span>}
    </div>
  );
}

// ---------- Choices (pick one of several equivalent options) ----------

function ChoiceGrid({ children }: { children: React.ReactNode }) {
  return (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
      {children}
    </div>
  );
}

/** One option: selecting it shows its install / status below, the others stay alternatives. */
function Choice({
  selected,
  onSelect,
  mark,
  title,
  note,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  mark: React.ReactNode;
  title: string;
  note: string;
  badge?: "in use" | "running" | "installed" | "recommended";
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-foreground/40 bg-foreground/[0.04]" : "border-border hover:border-foreground/20",
      )}
    >
      {mark}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[0.8125rem] font-medium text-foreground">
          {title}
          {badge && (
            <span
              className={cn(
                "rounded px-1.5 py-px text-[0.65625rem] font-normal",
                badge === "recommended"
                  ? "border border-border text-muted-foreground"
                  : badge === "running"
                    ? "border border-emerald-500/30 text-emerald-500"
                    : "bg-emerald-500/10 text-emerald-500",
              )}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[0.75rem] text-muted-foreground">{note}</span>
      </span>
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-foreground" : "border-border")}>
        {selected && <span className="size-2 rounded-full bg-foreground" />}
      </span>
    </button>
  );
}

/** What to do for the selected option: install it, get it, or nothing (it's ready). */
function ChoiceAction({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left">{children}</div>;
}

// ---------- Small parts ----------

function Log({ setup }: { setup: MachineSetupState }) {
  const { logs } = setup;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [logs]);
  if (logs.length === 0) return null;
  return (
    <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-[#070707] p-3 text-left font-mono text-[11.5px] leading-relaxed text-muted-foreground">
      {logs.join("\n")}
      <div ref={end} />
    </pre>
  );
}

function CmdRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-[#070707] px-3 py-2">
      <code className="flex-1 overflow-x-auto text-left font-mono text-[12px] text-foreground">{cmd}</code>
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
    <li className="flex gap-3 text-left">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 text-[12.5px] leading-relaxed text-foreground">{children}</div>
    </li>
  );
}

function Outcome({ title, ok, detail }: { title: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3.5 py-3 text-left last:border-b-0">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground",
        )}
      >
        <CheckCircle2 className="size-4" />
      </span>
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-[12px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function Skipped({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-left">
      <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
      <p className="text-[12px] text-muted-foreground">{reason}</p>
    </div>
  );
}
