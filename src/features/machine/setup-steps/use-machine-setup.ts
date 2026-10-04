import { useEffect, useRef, useState } from "react";
import { type SelfTestResult } from "@/features/machine/self-test";
import { getVmProvider } from "@/lib/settings";
import { installDependency, installVagrantPlugin, machineSelftestPrefetch, type Dependency, type DockerEngine, type SystemReport } from "@/lib/tauri";
import { hasHypervisor, isDockerReady } from "@/features/machine/setup-steps/steps";

export function useMachineSetup(report: SystemReport | null, onRefresh: () => void) {
  const prefetched = useRef({ docker: false, vm: false });
  const dockerReady = isDockerReady(report);
  const vmReady = hasHypervisor(report) && !!report?.vagrant.installed;
  useEffect(() => {
    if (dockerReady && !prefetched.current.docker) {
      prefetched.current.docker = true;
      machineSelftestPrefetch("docker", null).catch(() => {});
    }
    if (vmReady && !prefetched.current.vm) {
      prefetched.current.vm = true;
      machineSelftestPrefetch("vm", getVmProvider()).catch(() => {});
    }
  }, [dockerReady, vmReady]);

  const [installing, setInstalling] = useState<string | null>(null);
  const [installerOpened, setInstallerOpened] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [dockerTest, setDockerTest] = useState<SelfTestResult>("idle");
  const [vmTest, setVmTest] = useState<SelfTestResult>("idle");
  // The option the player picked on the engine / hypervisor steps (null = not picked yet).
  const [engine, setEngine] = useState<DockerEngine | null>(null);
  const [hypervisor, setHypervisor] = useState<string | null>(null);
  async function install(id: string, dep: Dependency, first: string) {
    setInstalling(id);
    setLogs([first]);
    try {
      await installDependency(dep, (line) => setLogs((l) => [...l, line]));
      if (dep === "docker") setInstallerOpened(true);
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setInstalling(null);
      onRefresh();
    }
  }

  /** Adds the Vagrant plugin a hypervisor needs (e.g. vagrant-vmware-desktop). */
  async function installPlugin(plugin: string) {
    setInstalling(plugin);
    setLogs([`Installing the Vagrant plugin ${plugin}…`]);
    try {
      await installVagrantPlugin(plugin, (line) => setLogs((l) => [...l, line]));
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setInstalling(null);
      onRefresh();
    }
  }

  return {
    installing,
    installerOpened,
    installPlugin,
    logs,
    dockerTest,
    setDockerTest,
    vmTest,
    setVmTest,
    install,
    onRefresh,
    engine,
    setEngine,
    hypervisor,
    setHypervisor,
    /** Something is running: the flow should not move to another step. */
    busy: installing !== null || dockerTest === "running" || vmTest === "running",
  };
}
export type MachineSetupState = ReturnType<typeof useMachineSetup>;
