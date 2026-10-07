import { Channel, invoke } from "@tauri-apps/api/core";

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
  | "aws"
  | "azure"
  | "gcp"
  | "digitalocean"
  | "linode"
  | "oci";

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
  pkgManager: { name: string; installed: boolean; version: string | null };
  docker: Tool;
  dockerRunning: boolean;
  /** The Docker-compatible engine that answers, when one does. */
  dockerEngine: DockerEngine | null;
  /** Every engine whose Docker context answers; several can run side by side. */
  dockerEnginesRunning: DockerEngine[];
  dockerCompose: Tool;
  vagrant: Tool;
  terraform: Tool;
  /** VMware OVF Tool (the ESXi Vagrant plugin needs it). */
  ovftool: Tool;
  cloudClis: { aws: Tool; azure: Tool; gcloud: Tool };
  vmProviders: ProviderStatus[];
}

export const systemCheck = () => invoke<SystemReport>("system_check");
/** Points the Docker CLI at another running engine (`docker context use`). */
export const dockerUseEngine = (engine: DockerEngine) => invoke<void>("docker_use_engine", { engine });

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
/** Opens the setup window, optionally at one step (e.g. "docker", "vm"). */
export const machineOpenSetup = (step?: string) => invoke<void>("machine_open_setup", { step: step ?? null });

export type Dependency = "docker" | "vagrant" | "terraform" | "virtualbox" | "qemu" | "utm" | "libvirt" | "awscli" | "azurecli" | "gcloud" | "wsl";

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

/** One step of a setup self-test, as it progresses. */
export interface SelfTestEvent {
  step: string;
  label: string;
  state: "running" | "ok" | "fail" | "skip";
  detail: string | null;
}

/** Runs a setup self-test: `docker` boots a throwaway two-container lab, `vm` checks the hypervisor + Vagrant. */
export function machineSelftest(kind: "docker" | "vm", provider: Provider | null, onEvent: (e: SelfTestEvent) => void) {
  const events = new Channel<SelfTestEvent>();
  events.onmessage = onEvent;
  return invoke<void>("machine_selftest", { kind, provider, events });
}

/** Starts a self-test's download (test image / VM box) in the background, so the test itself is quick. */
export const machineSelftestPrefetch = (kind: "docker" | "vm", provider: Provider | null) => invoke<void>("machine_selftest_prefetch", { kind, provider });

/** Something Cyber CTF is running here: a lab's containers or VMs, or a setup test. */
export interface Workload {
  id: string;
  kind: "docker" | "vm";
  count: number;
  /** 0 when unknown (VMs). */
  memBytes: number;
  provider: string | null;
}
export const machineWorkloads = () => invoke<Workload[]>("machine_workloads");
export const machineWorkloadStop = (kind: "docker" | "vm", id: string) => invoke<void>("machine_workload_stop", { kind, id });

export interface StoredItem {
  name: string;
  bytes: number;
}
/** Images and VM boxes Cyber CTF downloaded, present on this machine. */
export interface Storage {
  images: StoredItem[];
  boxes: StoredItem[];
}
export const machineStorage = (extraImages: string[]) => invoke<Storage>("machine_storage", { extraImages });
/** Removes them (not ones still in use). Resolves to the bytes freed. */
export const machineStorageClean = (extraImages: string[]) => invoke<number>("machine_storage_clean", { extraImages });

/** Compressed download size (bytes) of an image for this machine, from Docker Hub; null if unknown. */
export const imageDownloadSize = (image: string) => invoke<number | null>("image_download_size", { image });
