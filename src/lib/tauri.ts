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
  | "proxmox"
  | "aws";

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

export type DockerEngine = "docker-desktop" | "orbstack" | "colima" | "rancher-desktop" | "podman" | "docker-engine";

export interface SystemReport {
  os: string;
  arch: string;
  pkgManager: { name: string; installed: boolean };
  docker: Tool;
  dockerRunning: boolean;
  /** The Docker-compatible engine that answers, when one does. */
  dockerEngine: DockerEngine | null;
  dockerCompose: Tool;
  vagrant: Tool;
  terraform: Tool;
  cloudClis: { aws: Tool; azure: Tool; gcloud: Tool };
  vmProviders: ProviderStatus[];
}

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

/** Opens the guided "set up this machine" window. */
export const machineOpenSetup = () => invoke<void>("machine_open_setup");

export function labStart(id: string, runtime: Runtime, provider: Provider | null, host: string | null, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_start", { id, runtime, provider, host, logs });
}

export function labStop(id: string, runtime: Runtime, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_stop", { id, runtime, logs });
}

export const labStatus = (id: string, runtime: Runtime) => invoke<LabStatus>("lab_status", { id, runtime });

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

/**
 * startLab + download at the pinned commit + run with the launch token. VM labs run on
 * this machine with `provider`, or on the server `host` (a host id) when given.
 */
export function labLaunch(
  labId: string,
  provider: Provider | null,
  host: string | null,
  attackboxImage: string | null,
  onLog: (line: string) => void,
) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("lab_launch", { labId, provider, host, attackboxImage, logs });
}

// --- Server (the player's own ESXi / Proxmox host) ---

export type RemoteProvider = Extract<Provider, "vmware_esxi" | "proxmox" | "aws">;

export interface ServerHost {
  id: string;
  name: string;
  provider: RemoteProvider;
  host: string;
  /** ESXi SSH port (22) / Proxmox API port (8006). */
  port: number;
  /** ESXi: root. Proxmox: user@realm, e.g. root@pam. */
  username: string;
  /** ESXi datastore / Proxmox storage. */
  datastore: string | null;
  /** ESXi port group / Proxmox bridge. */
  network: string | null;
  /** Proxmox node. */
  node: string | null;
  /** Proxmox: accept the API's self-signed certificate. */
  insecureTls: boolean;
  /** AWS: terminate a lab's instance this many hours after start (0 = never). */
  autoStopHours: number | null;
}

/** Form payload; `id` null creates a host, `password` null keeps the stored one. */
export interface ServerHostInput extends Omit<ServerHost, "id" | "port"> {
  id: string | null;
  port: number | null;
  password: string | null;
}

export interface ServerList {
  default: string | null;
  hosts: ServerHost[];
}

export interface ServerTest {
  /** Everything checked passed. */
  ok: boolean;
  reachable: boolean;
  /** Credentials verified (Proxmox); null when not checked. */
  authenticated: boolean | null;
  latencyMs: number | null;
  message: string;
}

export const serverList = () => invoke<ServerList>("server_list");
export const serverSave = (input: ServerHostInput) => invoke<ServerHost>("server_save", { input });
export const serverRemove = (id: string) => invoke<void>("server_remove", { id });
export const serverSetDefault = (id: string | null) => invoke<void>("server_set_default", { id });
export const serverTest = (id: string) => invoke<ServerTest>("server_test", { id });
/** How many installed labs are currently running on each host, keyed by host id. */
export const serverRunningLabs = () => invoke<Record<string, number>>("server_running_labs");
/** Opens (or focuses) the setup window, for a new host or to edit `id`. */
export const serverOpenSetup = (id: string | null, kind: "server" | "cloud" = "server") =>
  invoke<void>("server_open_setup", { id, kind });
/** Emitted by the setup window after a save; the main window reloads its host list. */
export const SERVER_CHANGED = "server:changed";

export interface AgentInfo {
  installId: string;
  name: string;
  arch: string;
  capabilities: string[];
}

/** This machine's launcher-agent identity (for the Settings screen). */
export const agentInfo = () => invoke<AgentInfo>("agent_info");

export type Dependency = "docker" | "vagrant" | "terraform" | "virtualbox" | "qemu" | "utm" | "libvirt" | "awscli" | "azurecli" | "gcloud";

/** Assisted one-click install of a lab dependency, streaming the installer output. */
export function installDependency(dependency: Dependency, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("install_dependency", { dependency, logs });
}

export type CloudProvider = "aws" | "azure" | "gcp";

/** Signs in to a cloud provider using its CLI's own auth (browser flow). */
export function cloudLogin(provider: CloudProvider, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("cloud_login", { provider, logs });
}

export interface ProvisioningImage {
  name: string;
  image: string;
  present: boolean;
}

/** The Docker images provisioning uses (Terraform, Ansible) and whether each is pulled. */
export const provisioningImages = () => invoke<ProvisioningImage[]>("provisioning_images");

/** Pulls a provisioning image, streaming docker's output. */
export function provisioningPull(image: string, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("provisioning_pull", { image, logs });
}

/** Installs a Vagrant plugin (userland), streaming the output. */
export function installVagrantPlugin(plugin: string, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("install_vagrant_plugin", { plugin, logs });
}
