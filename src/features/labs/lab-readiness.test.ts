import { describe, expect, it } from "vitest";

import { setupNeeded } from "@/features/labs/lab-readiness";
import type { Lab } from "@/features/labs/use-labs";
import type { ProviderStatus, SystemReport } from "@/lib/tauri";

const provider = (p: string, remote = false, available = false): ProviderStatus => ({
  provider: p as ProviderStatus["provider"],
  remote,
  available,
  hypervisor: available,
  plugin: null,
  pluginInstalled: available,
  reason: null,
});

const report = (vmProviders: ProviderStatus[]) => ({ docker: { installed: true }, dockerRunning: true, vmProviders }) as unknown as SystemReport;

const vmLab = (providers: string[]) => ({ runtime: { runtime: "VM", providers } }) as unknown as Lab;

describe("setupNeeded", () => {
  it("names the local hypervisors a VM lab supports", () => {
    const r = report([provider("libvirt"), provider("virtualbox"), provider("parallels")]);
    expect(setupNeeded(vmLab(["virtualbox", "parallels", "aws"]), r, [])).toBe("Needs VirtualBox or Parallels, or a server");
  });

  it("does not offer a hypervisor the lab does not support", () => {
    // The report lists every local hypervisor, installed or not; libvirt is not one of this lab's.
    const r = report([provider("libvirt"), provider("virtualbox")]);
    expect(setupNeeded(vmLab(["virtualbox"]), r, [])).toBe("Needs VirtualBox, or a server");
  });

  it("is null when a supported hypervisor is usable", () => {
    const r = report([provider("virtualbox", false, true)]);
    expect(setupNeeded(vmLab(["virtualbox"]), r, [])).toBeNull();
  });
});
