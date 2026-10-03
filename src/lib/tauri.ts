import { Channel, invoke } from "@tauri-apps/api/core";

// Typed wrappers around the Rust commands in src-tauri. Keep in sync with the
// serde shapes there (camelCase fields, UPPERCASE runtimes, snake_case providers).

export type Runtime = "DOCKER" | "VM";

export type Provider =
  | "virtualbox"
  | "vmware_desktop"
  | "hyperv"
  | "parallels"
  | "libvirt"
  | "qemu"
  | "utm"
  | "vmware_esxi"
  | "proxmox";

export interface Tool {
  installed: boolean;
  version: string | null;
}

export interface ProviderStatus {
  provider: Provider;
  remote: boolean;
  available: boolean;
  /** The hypervisor itself is installed; null when there is nothing local to probe. */
  hypervisor: boolean | null;
  /** The Vagrant plugin this provider needs, if not built in. */
  plugin: string | null;
  pluginInstalled: boolean;
  reason: string | null;
}

export interface SystemReport {
  os: string;
  arch: string;
  docker: Tool;
  dockerRunning: boolean;
  dockerCompose: Tool;
  vagrant: Tool;
  vmProviders: ProviderStatus[];
}

export interface LabStatus {
  running: boolean;
  machines: { name: string; state: string; image: string; ip: string; ports: { published: number; target: number }[] }[];
  /** Loopback URL where the lab is reachable, once running (null for VM labs / no port). */
  url: string | null;
}

export const systemCheck = () => invoke<SystemReport>("system_check");

export interface MachineMetrics {
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptimeSecs: number;
  cores: number;
  containers: number;
}

/** Live machine health (CPU/memory/disk/uptime + running containers). */
export const machineMetrics = () => invoke<MachineMetrics>("machine_metrics");

export function labStart(id: string, runtime: Runtime, provider: Provider | null, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_start", { id, runtime, provider, logs });
}

export function labStop(id: string, runtime: Runtime, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_stop", { id, runtime, logs });
}

export const labStatus = (id: string, runtime: Runtime) => invoke<LabStatus>("lab_status", { id, runtime });

export interface ExegolStatus {
  imagePresent: boolean;
  running: boolean;
  ip: string;
  shellCmd: string;
}

/** Status of a lab's attack box (Exegol). */
export const exegolStatus = (id: string) => invoke<ExegolStatus>("exegol_status", { id });

export function exegolStart(id: string, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("exegol_start", { id, logs });
}

export function exegolStop(id: string, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("exegol_stop", { id, logs });
}

/** Opens the OS terminal attached to the running attack box. */
export const exegolShell = (id: string) => invoke<void>("exegol_shell", { id });

export interface AuthStatus {
  loggedIn: boolean;
  name: string | null;
  email: string | null;
}

export const authStatus = () => invoke<AuthStatus>("auth_status");
/** Opens the system browser on cyberauth.co and resolves once the player is back. */
export const authLogin = () => invoke<AuthStatus>("auth_login");
export const authLogout = () => invoke<void>("auth_logout");

/** GraphQL against CyberBackend; the Rust side attaches the player's token. */
export const apiQuery = <T>(query: string, variables?: Record<string, unknown>) =>
  invoke<T>("api_query", { query, variables });

/** startLab + download at the pinned commit + run with the launch token. */
export function labLaunch(labId: string, provider: Provider | null, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_launch", { labId, provider, logs });
}

export interface AgentInfo {
  installId: string;
  name: string;
  arch: string;
  capabilities: string[];
}

/** This machine's launcher-agent identity (for the Settings screen). */
export const agentInfo = () => invoke<AgentInfo>("agent_info");

export type Dependency = "docker" | "vagrant" | "virtualbox";

/** Assisted one-click install of a lab dependency, streaming the installer output. */
export function installDependency(dependency: Dependency, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("install_dependency", { dependency, logs });
}

/** Installs a Vagrant plugin (userland), streaming the output. */
export function installVagrantPlugin(plugin: string, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("install_vagrant_plugin", { plugin, logs });
}
