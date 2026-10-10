import type { HostCapacity, ServerHost, ServerTest, SystemReport } from "@/lib/tauri";
import type { Tone } from "@/components/ui/status-pill";

// The Servers page's logic, as pure functions of the hosts, their tests and capacity.

/** The hosts the Servers page lists: AWS, Azure and GCP accounts live on the Cloud page. */
export const onPremHosts = (hosts: ServerHost[]) => hosts.filter((h) => h.provider !== "aws" && h.provider !== "azure" && h.provider !== "gcp");

/** The hosts panel's summary: how many answered the last test, and its tone. */
export function hostsSummary(hosts: ServerHost[], tests: Record<string, ServerTest | "testing">) {
  const online = hosts.filter((h) => {
    const r = tests[h.id];
    return !!r && r !== "testing" && r.ok;
  }).length;
  const anyTesting = hosts.some((h) => tests[h.id] === "testing");
  const tone: Tone = hosts.length === 0 ? "warn" : anyTesting ? "muted" : online === hosts.length ? "ok" : online > 0 ? "warn" : "fail";
  return { online, anyTesting, tone };
}

/** The host the capacity panel shows: the default when it answered, else the first that did. */
export function capacityHost(hosts: ServerHost[], defaultId: string | null, caps: Record<string, HostCapacity | null>) {
  const host = hosts.find((h) => h.id === defaultId && caps[h.id]) ?? hosts.find((h) => caps[h.id]) ?? null;
  const cap = host ? caps[host.id] : null;
  return host && cap ? { host, cap } : null;
}

/** Whether this machine already runs VM labs itself (then a server isn't suggested). */
export const canRunVmHere = (report: SystemReport) => report.vmProviders.some((p) => !p.remote && p.available && p.hypervisor !== false);
