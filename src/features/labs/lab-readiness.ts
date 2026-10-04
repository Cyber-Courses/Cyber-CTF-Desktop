import type { Lab } from "@/features/labs/use-labs";
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
  return local || remote ? null : "Needs a hypervisor";
}
