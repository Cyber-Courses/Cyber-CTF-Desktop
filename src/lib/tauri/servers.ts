import { invoke } from "@tauri-apps/api/core";
import { invokeStreaming } from "@/lib/tauri/stream";
import type { Provider, SelfTestEvent } from "@/lib/tauri/machine";

// --- Server (the player's own ESXi / Proxmox host) ---

export type RemoteProvider = Extract<Provider, "vmware_esxi" | "proxmox" | "aws" | "azure" | "gcp" | "digitalocean" | "linode" | "oci">;

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
  /** AWS: use the AWS CLI's own credentials (default chain) instead of stored keys. */
  useCliCreds?: boolean;
  /** AWS: the CLI profile to use with useCliCreds (null/undefined = default profile). */
  awsProfile?: string | null;
  /** AWS: monthly spend limit in USD (null/0 = no limit). */
  monthlyLimit?: number | null;
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

/** One named pre-flight check in a cloud account test. */
export interface ServerCheck {
  name: string;
  state: "ok" | "warn" | "fail";
  detail: string;
}

export interface ServerTest {
  /** Everything checked passed. */
  ok: boolean;
  reachable: boolean;
  /** Credentials verified (Proxmox); null when not checked. */
  authenticated: boolean | null;
  latencyMs: number | null;
  message: string;
  /** The individual checks (cloud accounts only; empty for servers). */
  checks: ServerCheck[];
}

export const serverList = () => invoke<ServerList>("server_list");
export const serverSave = (input: ServerHostInput) => invoke<ServerHost>("server_save", { input });
export const serverRemove = (id: string) => invoke<void>("server_remove", { id });
export const serverSetDefault = (id: string | null) => invoke<void>("server_set_default", { id });
export const serverTest = (id: string) => invoke<ServerTest>("server_test", { id });
/** The launcher's SSH public key; token-auth Proxmox hosts must authorize it for SSH. */
export const serverPublicKey = () => invoke<string>("server_public_key");
/** How many installed labs are currently running on each host, keyed by host id. */
export const serverRunningLabs = () => invoke<Record<string, number>>("server_running_labs");
/** A host's hardware headroom (Proxmox only; null otherwise or on failure). */
export interface HostCapacity {
  cores: number;
  memTotal: number;
  memFree: number;
}
export const serverCapacity = (id: string) => invoke<HostCapacity | null>("server_capacity", { id });
/** Real-VM self-test: provisions a throwaway VM on the host, checks it, then destroys it. */
export const serverSelftest = (id: string, onEvent: (e: SelfTestEvent) => void) => invokeStreaming<SelfTestEvent>("server_selftest", { id }, onEvent, "events");
/** Opens (or focuses) the setup window, for a new host or to edit `id`. */
export const serverOpenSetup = (id: string | null, kind: "server" | "cloud" = "server") => invoke<void>("server_open_setup", { id, kind });
/** Emitted by the setup window after a save; the main window reloads its host list. */
export const SERVER_CHANGED = "server:changed";
