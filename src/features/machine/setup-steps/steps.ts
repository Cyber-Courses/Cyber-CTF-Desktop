import { Container, Cpu, Crosshair, FlaskConical, Package, Server, type LucideIcon } from "lucide-react";
import { type SystemReport } from "@/lib/tauri";
import { INSTALLABLE, usableHypervisors } from "@/features/machine/hypervisors";
import { ENGINES, Engine } from "@/features/machine/setup-steps/engines";
import { MachineSetupState } from "@/features/machine/setup-steps/use-machine-setup";

export type MachineStep = "pkgmgr" | "virtualization" | "docker" | "docker-test" | "attack" | "vm" | "vagrant" | "vm-test";

/** The steps this machine needs, in order. OS-aware: Windows gets the WSL step. */
export function machineSteps(report: SystemReport | null): MachineStep[] {
  return ["pkgmgr", ...(report?.os === "windows" ? (["virtualization"] as const) : []), "docker", "docker-test", "attack", "vm", "vagrant", "vm-test"];
}

export const isDockerReady = (r: SystemReport | null) => !!r && r.docker.installed && r.dockerRunning;
export const hasHypervisor = (r: SystemReport | null) => !!r && usableHypervisors(r).some((p) => p.hypervisor === true);

export function stepMeta(step: MachineStep, report: SystemReport | null): { icon: LucideIcon; title: string; description: string } {
  const pm = report?.pkgManager.name ?? "a package manager";
  // macOS asks for a few things along the way; say so before the step that triggers each prompt.
  const mac = report?.os === "macos";
  const localNetwork = mac ? " macOS may ask to let Cyber CTF find devices on your local network: choose Allow, labs need it." : "";
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
          "Labs built from full VMs (Active Directory domains, Windows hosts, routers, multi-host networks) need one hypervisor, whichever you prefer. You can also add one later from the Machine page." +
          (mac
            ? " Its installer opens in its own window and asks for your password; VirtualBox may also need approval in System Settings > Privacy & Security."
            : ""),
      };
    case "vagrant":
      return {
        icon: Package,
        title: "Provisioning",
        description:
          "Cyber CTF creates and starts each lab's virtual machines with Vagrant, a free tool, on your hypervisor. Most hypervisors also need a small add-on (plugin) for it." +
          (mac ? " Its installer opens in its own window and asks for your password." : ""),
      };
    case "docker-test":
      return {
        icon: FlaskConical,
        title: "Test container labs",
        description: "Starts a tiny two-container lab, checks it works, then deletes it. About 2 MB to download." + localNetwork,
      };
    case "vm-test":
      return {
        icon: FlaskConical,
        title: "Test VM labs",
        description:
          "Boots a real test VM, checks it works, then deletes it. Takes a few minutes; the first run downloads a small VM image (cached after)." +
          localNetwork,
      };
  }
}

/** Install + test state for the setup steps. One per flow, passed to every step body.
 *  Starts each test's download in the background as soon as the machine can run it. */

/** Label for the flow's forward button on this step. */
export function nextLabel(step: MachineStep, report: SystemReport | null): string {
  if (step === "virtualization") return "I’ve done this";
  if (step === "vm-test" && !hasHypervisor(report)) return "Skip for now";
  // A hypervisor is optional (VM labs can run on a server): with none set up, the VM steps
  // can be passed by.
  if ((step === "vm" || step === "vagrant") && !hasHypervisor(report)) return "Skip for now";
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
  if (step === "docker") {
    if (!isDockerReady(report)) return false;
    // A working engine this step has no tile for (Podman) is fine unless another was picked.
    const known = ENGINES.some((e) => e.id === report.dockerEngine);
    return report.dockerEngine === chosenEngine(report, setup).id || (!known && !setup.engine);
  }
  // A hypervisor is optional, as the step says (VM labs can go to a Server, and one can be added
  // later from the Machine page): the flow never waits on one.
  if (step === "vm") return true;
  if (step === "vagrant") {
    const choice = chosenHypervisor(report, setup);
    // No local hypervisor set up (VM labs go to a Server): nothing for Vagrant to drive here.
    if (!choice || choice.hypervisor !== true) return true;
    // Vagrant, and the plugin that lets it drive the chosen hypervisor.
    return report.vagrant.installed && (!choice.plugin || choice.pluginInstalled);
  }
  return true;
}
