import { Cloud, Container, Globe, Monitor, Server, type LucideIcon } from "lucide-react";
import type { LabRuntimeInfo } from "@/features/labs/use-labs";
import type { LabStatus, Provider, ServerHost, SystemReport } from "@/lib/tauri";

// Where a lab can run, from its runtime (catalogue) and what this machine has ready.

const SERVERS = new Set(["vmware_esxi", "proxmox"]);
export const CLOUDS = new Set(["aws", "azure", "gcp", "digitalocean", "linode", "oci"]);
// VM labs: one VM per machine on ESXi, Proxmox and AWS (Isoloom's vagrant, proxmox and cloud-vm
// outputs); the other clouds run container labs only for now.
const VM_CLOUDS_NOT_YET = new Set(["azure", "gcp", "digitalocean", "linode", "oci"]);

/** Hypervisors that run VMs built for another CPU, emulated (slowly): QEMU runs an x86 lab on
 *  an Apple Silicon Mac. */
export const EMULATORS: readonly Provider[] = ["qemu"];

// providers also carries "hosted" (not a launcher Provider), so compare as strings.
const isLocal = (p: string) => !SERVERS.has(p) && !CLOUDS.has(p) && p !== "hosted";

/** Whether the lab is built for this CPU (no architectures listed = any). */
export const runsNatively = (rt: LabRuntimeInfo, hostArch: string) => !rt.architectures.length || rt.architectures.includes(hostArch);

/** Whether an emulator (QEMU) is ready on this machine: Vagrant, the hypervisor and its plugin. */
export const emulatorReady = (report: SystemReport | null | undefined) =>
  !!report?.vagrant.installed && report.vmProviders.some((p) => EMULATORS.includes(p.provider) && !p.remote && p.available && p.hypervisor !== false);

/** The local hypervisors ready for a lab VM (Vagrant + hypervisor), `preferred` (Settings'
 *  choice) first. Only the report's fields this reads, so a partial report type fits. */
export function readyHypervisors(
  report: {
    vagrant: { installed: boolean };
    vmProviders: { provider: Provider; remote: boolean; available: boolean; hypervisor?: boolean | null }[];
  },
  preferred: Provider | null | undefined,
): Provider[] {
  const ready = report.vagrant.installed ? report.vmProviders.filter((p) => !p.remote && p.available && p.hypervisor !== false).map((p) => p.provider) : [];
  return preferred && ready.includes(preferred) ? [preferred, ...ready.filter((p) => p !== preferred)] : ready;
}

/** The hypervisors on this machine that can run the lab's VMs: those the lab lists, except for
 *  a VM lab built for another CPU, which only an emulator can run (whatever the lab lists: its
 *  list names the hypervisors of its own CPU). */
export function localProviders(rt: LabRuntimeInfo, hostArch?: string): Provider[] {
  if (rt.runtime === "VM" && hostArch && !runsNatively(rt, hostArch)) return [...EMULATORS];
  return rt.providers.filter((p: string) => isLocal(p));
}

/** Whether a saved server or cloud account can run the lab. */
export const hostSupports = (rt: LabRuntimeInfo | null, h: ServerHost) =>
  !!rt?.providers.includes(h.provider) && !(rt.runtime === "VM" && VM_CLOUDS_NOT_YET.has(h.provider));

export type PlaceKey = NonNullable<LabStatus["place"]> | "hosted";

/** Every place a lab could run, and whether this one can (its runtime here, then its providers).
 *  Its words are `labs.places.<key>`.
 *  A VM lab built for another CPU (x86 Windows on Apple Silicon) runs on this machine only
 *  emulated, so "VM on this machine" needs `emulates` (QEMU ready); containers run emulated
 *  anyway. */
export function runPlaces(rt: LabRuntimeInfo, hostArch?: string, emulates = false): { key: PlaceKey; icon: LucideIcon; available: boolean }[] {
  const local = rt.providers.some((p: string) => isLocal(p));
  const vm = rt.runtime === "VM";
  return [
    { key: "container", icon: Container, available: !vm },
    { key: "local_vm", icon: Monitor, available: (vm || local) && (!(vm && hostArch && !runsNatively(rt, hostArch)) || emulates) },
    { key: "server", icon: Server, available: rt.providers.some((p) => SERVERS.has(p)) },
    { key: "cloud", icon: Cloud, available: rt.providers.some((p) => CLOUDS.has(p)) },
    { key: "hosted", icon: Globe, available: rt.hosted ?? false },
  ];
}
