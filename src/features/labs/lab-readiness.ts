import type { Lab } from "@/features/labs/use-labs";
import { providerLabel } from "@/features/machine/hypervisors";
import type { ServerHost, SystemReport } from "@/lib/tauri";

/**
 * What this machine is missing to run a lab, from facts the launcher already checked: a
 * running container engine for Docker labs; for VM labs, a local hypervisor the lab
 * supports that is fully usable (hypervisor + Vagrant + plugin), or a saved server it
 * can run on. Null when it can run.
 */
export function setupNeeded(lab: Lab, report: SystemReport | null, servers: ServerHost[]): string | null {
  const rt = lab.runtime;
  if (!rt || !report) return null;
  if (rt.runtime === "DOCKER") {
    if (!report.docker.installed) return "Needs a container engine";
    if (!report.dockerRunning) return "Start your container engine";
    return null;
  }
  const local = report.vmProviders.some((p) => !p.remote && p.available && rt.providers.includes(p.provider));
  const remote = servers.some((h) => rt.providers.includes(h.provider));
  if (local || remote) return null;
  // Name the hypervisors this lab supports, not a generic "a hypervisor": a lab that runs on
  // VirtualBox or VMware says so, instead of looking as if nothing is installed.
  const supported = report.vmProviders.filter((p) => !p.remote && rt.providers.includes(p.provider)).map(providerLabel);
  if (supported.length === 0) return "Needs a server to run on";
  return `Needs ${joinOr(supported)}, or a server`;
}

/** "A", "A or B", "A, B or C". */
function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
