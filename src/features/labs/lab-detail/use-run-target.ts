"use client";

import { useCallback, useEffect, useState } from "react";
import { hostSupports, localProviders } from "@/features/labs/lab-runtime";
import type { RunTarget } from "@/features/labs/run-on";
import type { LabRuntimeInfo } from "@/features/labs/use-labs";
import { getPortMode, type PortMode } from "@/lib/settings";
import { serverList, type Provider, type ServerHost } from "@/lib/tauri";

/**
 * Where a lab starts, picked in "Where should it run?": this machine or one of the player's
 * server hosts (Docker labs through their deploy/ layer), a VM here for a container lab, or
 * hosted by Cyber CTF. VM labs default to the default host; Docker labs to here.
 */
export function useRunTarget(rt: LabRuntimeInfo | null, readyVms: Provider[], hostArch: string) {
  const isDocker = rt?.runtime !== "VM";
  const [hosts, setHosts] = useState<ServerHost[]>([]);
  const [runOn, setRunOn] = useState<RunTarget>({ kind: "local" });
  // A container lab here: its host ports (Settings' choice first).
  const [ports, setPorts] = useState<PortMode>(() => getPortMode() ?? "random");
  // A container lab can also run in a VM here: on the hypervisor chosen in Settings (readyVms
  // lists it first), else the first ready one its deploy/ supports. One option, not a catalogue.
  const localVm = isDocker ? (readyVms.find((p) => rt?.providers.includes(p)) ?? null) : null;
  const hostOk = useCallback((h: ServerHost) => hostSupports(rt, h), [rt]);
  // Prefer this machine when a local hypervisor can run the lab; fall back to the default server
  // only when none can. A default server shouldn't silently capture every VM lab.
  const localReady = isDocker || (!!rt && readyVms.some((p) => localProviders(rt, hostArch).includes(p)));
  useEffect(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        const def = l.hosts.find((h) => h.id === l.default);
        const preferHost = !localReady && def && hostOk(def);
        setRunOn(preferHost ? { kind: "host", id: def.id } : { kind: "local" });
      })
      .catch(() => setHosts([]));
  }, [hostOk, localReady]);

  return {
    hosts,
    hostOk,
    runOn,
    setRunOn,
    ports,
    setPorts,
    localVm,
    /** With servers saved (or a VM here, or hosted), Start asks where to run first. */
    hasChoice: hosts.length > 0 || localVm !== null || !!rt?.hosted,
    /** The target picked, with the host ports for a container lab here. */
    chosen: (): RunTarget => (runOn.kind === "local" && isDocker ? { kind: "local", ports } : runOn),
  };
}

export type RunTargetChoice = ReturnType<typeof useRunTarget>;
