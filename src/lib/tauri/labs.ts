import { Channel, invoke } from "@tauri-apps/api/core";
import type { Provider } from "@/lib/tauri/machine";

export type Runtime = "DOCKER" | "VM";

/** A machine's address on one lab network (the lab's name for it, e.g. "dmz"). */
export interface LabInterface {
  network: string;
  ip: string;
}

export interface LabMachine {
  name: string;
  state: string;
  image: string;
  ip: string;
  ports: { published: number; target: number }[];
  /** Every network it is plugged into; two or more = a pivot. Empty when unknown. */
  interfaces: LabInterface[];
  /** Services the lab declares inside it (compose labels); empty when none are declared. */
  services: LabService[];
}

/** A service inside a machine, as the lab declares it (`cyberctf.service.<name>`). */
export interface LabService {
  name: string;
  /** As declared: "web", "database", "cache", "worker", "ssh" or free text. */
  kind: string;
  /** Ports it listens on inside the container. */
  ports: number[];
}

/** A lab network segment (a Docker network = a switch). */
export interface LabNetwork {
  name: string;
  subnet: string;
  /** No route out (compose `internal: true`). */
  internal: boolean;
}

export interface LabStatus {
  running: boolean;
  machines: LabMachine[];
  /** The lab's network segments (Docker labs); empty when the runtime doesn't report them. */
  networks: LabNetwork[];
  /** Loopback URL where the lab is reachable, once running (null for VM labs / no port). */
  url: string | null;
  /** Server host name a VM lab runs on; null when it runs on this machine. */
  host: string | null;
  /** Unix seconds a cloud lab stops itself (auto-stop); null if it doesn't. */
  expiresAt: number | null;
  /** Where it runs: its container here, a VM here, a server or a cloud account. */
  place: "container" | "local_vm" | "server" | "cloud" | null;
  /** The engine or hypervisor it runs on: "docker", a Vagrant provider id ("virtualbox",
   *  "vmware_desktop", "parallels", ...) or a server/cloud provider; null when unknown. */
  provider: string | null;
}

export function labStop(id: string, runtime: Runtime, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_stop", { id, runtime, logs });
}

export const labStatus = (id: string, runtime: Runtime) => invoke<LabStatus>("lab_status", { id, runtime });

/** Lab ids running on this machine right now, found by scanning Docker and Vagrant directly.
 *  Recovers running labs after a crash/restart, independent of any per-lab status probe. */
export const runningLabs = () => invoke<string[]>("running_labs");

/** Result of a lab's exploitability self-check (the lab's `check` service). */
export interface LabCheck {
  available: boolean;
  ok: boolean;
  output: string;
}

/** Runs a lab's exploitability check: is the intended exploit path still solvable? */
export const labCheck = (id: string, runtime: Runtime) => invoke<LabCheck>("lab_check", { id, runtime });

export interface ExegolStatus {
  imagePresent: boolean;
  running: boolean;
  ip: string;
  /** The lab network the attack box is plugged into, once running. */
  labNetwork: string;
  shellCmd: string;
}

/** Status of a lab's attack box (Exegol) for the configured image. */
export const exegolStatus = (id: string, image: string) => invoke<ExegolStatus>("exegol_status", { id, image });

export function exegolStart(id: string, image: string, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("exegol_start", { id, image, logs });
}

export function exegolStop(id: string, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("exegol_stop", { id, logs });
}

/** Opens the OS terminal attached to the running attack box. */
export const exegolShell = (id: string) => invoke<void>("exegol_shell", { id });

/** Opens the attack box shell wherever the lab runs (local container, or SSH to a remote lab host). */
export const labAttackShell = (id: string, runtime: Runtime) => invoke<void>("lab_attack_shell", { id, runtime });
export function labLaunch(labId: string, provider: Provider | null, host: string | null, attackboxImage: string | null, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_launch", { labId, provider, host, attackboxImage, logs });
}

/** Whether leaving now would interrupt a lab deploy (a cloud apply keeps billing if cut off). */
export const deployInProgress = () => invoke<boolean>("deploy_in_progress");

/** The lab ids currently starting or stopping in the backend. Read on load to rehydrate the
 *  "starting" state after a window reload, which loses the in-memory deploy store. */
export const deployingLabs = () => invoke<string[]>("deploying_labs");

/** The lab ids being stopped right now (a teardown in flight is not a deploy). */
export const stoppingLabs = () => invoke<string[]>("stopping_labs");

/** The log so far of a lab's latest deploy, which runs in a detached worker process. Lets a
 *  reloaded or relaunched app re-attach to a deploy still in progress. */
export const labDeployLog = (id: string) => invoke<string>("lab_deploy_log", { id });

/** Quit by finishing in the background: hides the windows and exits once the in-app deploys
 *  (the fallback when no worker could be started) are done. */
export const lingerQuit = () => invoke<void>("linger_quit");

/** Quit the app even though a deploy is in progress (the user confirmed from the warning). */
export const forceQuit = () => invoke<void>("force_quit");
