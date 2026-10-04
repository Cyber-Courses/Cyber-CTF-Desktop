"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Container, Cpu, HardDrive, MemoryStick, Server, Square, Trash2, Wrench } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EngineMark, engineName } from "@/features/machine/setup-steps";
import {
  apiQuery,
  machineMetrics,
  machineOpenSetup,
  machineStorage,
  machineStorageClean,
  machineWorkloadStop,
  machineWorkloads,
  type MachineMetrics,
  type ProviderStatus,
  type Storage,
  type SystemReport,
  type Tool,
  type Workload,
} from "@/lib/tauri";
import { getAttackImage, getLastTest, getVmProvider, type LastTest } from "@/lib/settings";
import { PROVIDER_LABELS, providerLabel, usableHypervisors } from "@/features/machine/hypervisors";
import { cn } from "@/lib/utils";
import { DetailRow, LabKind, LabTypeRow, ListSkeleton, Stat } from "@/features/machine/machine-parts";
import { TypeIcon } from "@/components/ui/type-icon";
import { formatAgo, formatBytes, formatUptime } from "@/lib/format";

// ---------- formatting ----------

/** Strip the tool name from `docker --version`-style output, keep the version number. */
const ver = (t: Tool) => (t.installed ? (t.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "installed") : "not installed");
const OS_NAME: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

/** Free memory each lab type wants to start comfortably. */
const WANT_FREE = { docker: 2e9, vm: 8e9 };

// ---------- screen ----------

export function MachineScreen({
  report,
  onNavigate,
}: {
  report: SystemReport;
  onRefresh: () => void | Promise<void>;
  onNavigate: (tab: "cloud" | "server") => void;
}) {
  // Live usage, with the last minute of history for the sparklines.
  const [m, setM] = useState<MachineMetrics | null>(null);
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; disk: number[] }>({ cpu: [], mem: [], disk: [] });
  useEffect(() => {
    let alive = true;
    const push = (a: number[], v: number) => [...a, v].slice(-24);
    const tick = () =>
      machineMetrics()
        .then((x) => {
          if (!alive) return;
          setM(x);
          setHist((h) => ({
            cpu: push(h.cpu, x.cpu),
            mem: push(h.mem, x.memTotal ? (x.memUsed / x.memTotal) * 100 : 0),
            disk: push(h.disk, x.diskTotal ? (x.diskUsed / x.diskTotal) * 100 : 0),
          }));
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // What's running, polled slower (asks Docker and Vagrant).
  const [workloads, setWorkloads] = useState<Workload[] | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const loadWorkloads = useCallback(() => {
    machineWorkloads()
      .then(setWorkloads)
      .catch(() => setWorkloads([]));
  }, []);
  useEffect(() => {
    loadWorkloads();
    const id = setInterval(loadWorkloads, 8000);
    return () => clearInterval(id);
  }, [loadWorkloads]);

  // Lab titles for the running list (the runtime only knows ids).
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    apiQuery<{ labs: { id: string; title: string }[] }>("{ labs { id title } }")
      .then((d) => setTitles(Object.fromEntries(d.labs.map((l) => [l.id, l.title]))))
      .catch(() => {});
  }, []);

  // Downloaded images and VM boxes.
  const [storage, setStorage] = useState<Storage | null>(null);
  const [showStorage, setShowStorage] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);
  const loadStorage = useCallback(() => {
    machineStorage([getAttackImage()])
      .then(setStorage)
      .catch(() => setStorage({ images: [], boxes: [] }));
  }, []);
  useEffect(() => {
    loadStorage();
  }, [loadStorage]);

  // Last self-test per lab type (kept locally), and which test is open inline.
  const [last, setLast] = useState<Record<LabKind, LastTest | null>>(() => ({ docker: getLastTest("docker"), vm: getLastTest("vm") }));
  const [testing, setTesting] = useState<LabKind | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const refreshLast = () => {
    setLast({ docker: getLastTest("docker"), vm: getLastTest("vm") });
    setNow(Date.now());
    loadWorkloads();
  };

  async function stop(w: Workload) {
    setStopping(`${w.kind}:${w.id}`);
    try {
      await machineWorkloadStop(w.kind, w.id);
    } catch {
      /* the list shows what's still running */
    } finally {
      setStopping(null);
      loadWorkloads();
    }
  }

  async function clean() {
    setCleaning(true);
    try {
      setFreed(await machineStorageClean([getAttackImage()]));
    } catch {
      setFreed(0);
    } finally {
      setCleaning(false);
      setConfirmClean(false);
      loadStorage();
    }
  }

  // ----- each lab type -----
  const memFree = m ? m.memTotal - m.memUsed : null;
  const lowFor = (kind: LabKind) => memFree !== null && memFree < WANT_FREE[kind];
  const freeHint = (kind: LabKind) =>
    lowFor(kind)
      ? `${kind === "vm" ? "VM" : "Container"} labs want about ${formatBytes(WANT_FREE[kind])} of free memory; ${formatBytes(Math.max(0, memFree!))} free now.`
      : undefined;
  const testLine = (t: LastTest | null) =>
    !t ? (
      <span>not tested yet</span>
    ) : t.result === "ok" ? (
      <span>tested {formatAgo(t.at, now)}</span>
    ) : (
      <span className="text-rose-500">last test failed {formatAgo(t.at, now)}</span>
    );

  const dockerReady = report.docker.installed && report.dockerRunning;
  const hypervisors = usableHypervisors(report);
  const vmReadyList: ProviderStatus[] = report.vmProviders.filter((p) => !p.remote && p.available && p.hypervisor !== false);
  const preferred = getVmProvider();
  const vmProvider = vmReadyList.find((p) => p.provider === preferred) ?? vmReadyList[0] ?? null;
  const vmApplicable = hypervisors.length > 0;
  const hasHypervisor = hypervisors.some((p) => p.hypervisor === true);

  const fix = (step: string) => machineOpenSetup(step).catch(() => {});
  const testBtn = (kind: LabKind) => (
    <Button variant="outline" size="sm" onClick={() => setTesting(testing === kind ? null : kind)}>
      {testing === kind ? "Hide test" : "Test"}
    </Button>
  );

  const needsSetup = (!dockerReady ? 1 : 0) + (vmApplicable && !vmProvider ? 1 : 0);
  const labMem = (workloads ?? []).reduce((a, w) => a + w.memBytes, 0);
  const storeItems = storage ? [...storage.images, ...storage.boxes] : [];
  const storeTotal = storeItems.reduce((a, i) => a + i.bytes, 0);
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const diskPct = m && m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium",
            needsSetup ? "border-amber-500/30 text-amber-500" : "border-emerald-500/30 text-emerald-500",
          )}
        >
          <span className={cn("size-1.5 rounded-full", needsSetup ? "bg-amber-500" : "bg-emerald-500")} />
          {needsSetup ? `${needsSetup} lab ${needsSetup === 1 ? "type needs" : "types need"} setup` : "Ready for labs"}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {OS_NAME[report.os] ?? report.os} · {report.arch}
          {m ? ` · up ${formatUptime(m.uptimeSecs)}` : ""}
        </span>
        <Button className="ml-auto" variant={needsSetup ? "learn" : "outline"} size="sm" onClick={() => machineOpenSetup().catch(() => {})}>
          <Wrench className="size-3.5" /> {needsSetup ? "Set up this machine" : "Setup"}
        </Button>
      </div>

      {/* Live usage */}
      <Panel className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat icon={Cpu} label="CPU" value={m ? `${Math.round(m.cpu)}%` : null} sub={m ? `${m.cores} cores` : ""} history={hist.cpu} />
        <Stat
          icon={MemoryStick}
          label="Memory"
          value={m ? `${Math.round(memPct)}%` : null}
          sub={m ? `${formatBytes(m.memUsed)} / ${formatBytes(m.memTotal)}` : ""}
          history={hist.mem}
        />
        <Stat
          icon={HardDrive}
          label="Disk"
          value={m ? `${Math.round(diskPct)}%` : null}
          sub={m ? `${formatBytes(m.diskTotal - m.diskUsed)} free` : ""}
          history={hist.disk}
        />
      </Panel>

      {/* What can run */}
      <Panel>
        <PanelHeader title="Labs on this machine" />
        <LabTypeRow
          kind="docker"
          icon={
            dockerReady && report.dockerEngine ? (
              <EngineMark id={report.dockerEngine} />
            ) : (
              <TypeIcon>
                <Container className="size-4" />
              </TypeIcon>
            )
          }
          title="Container labs"
          tone={dockerReady ? (last.docker?.result === "fail" ? "fail" : "ok") : "warn"}
          status={dockerReady ? (last.docker?.result === "fail" ? "Test failed" : "Ready") : report.docker.installed ? "Engine stopped" : "Needs setup"}
          detail={
            dockerReady ? (
              <>
                {report.dockerEngine ? engineName(report.dockerEngine) : "Docker"} · {testLine(last.docker)}
              </>
            ) : report.docker.installed ? (
              "A container engine is installed but not running. Start it to run labs."
            ) : (
              "No container engine yet. Docker Desktop, OrbStack or Colima all work."
            )
          }
          hint={dockerReady ? freeHint("docker") : undefined}
          actions={
            dockerReady ? (
              testBtn("docker")
            ) : (
              <Button variant="learn" size="sm" onClick={() => fix("docker")}>
                Fix
              </Button>
            )
          }
          testing={testing === "docker"}
          onTestDone={refreshLast}
        />
        <LabTypeRow
          kind="vm"
          icon={
            <TypeIcon>
              <Server className="size-4" />
            </TypeIcon>
          }
          title="VM labs"
          tone={!vmApplicable ? "muted" : vmProvider ? (last.vm?.result === "fail" ? "fail" : "ok") : "warn"}
          status={!vmApplicable ? "Not on this machine" : vmProvider ? (last.vm?.result === "fail" ? "Test failed" : "Ready") : "Needs setup"}
          detail={
            !vmApplicable ? (
              "No local hypervisor runs on this machine. VM labs can run on a server instead."
            ) : vmProvider ? (
              <>
                {providerLabel(vmProvider)}
                {vmReadyList.length > 1 && !preferred ? " (automatic, change in Settings)" : ""} · {testLine(last.vm)}
              </>
            ) : hasHypervisor ? (
              "Vagrant or the hypervisor's Vagrant plugin is missing."
            ) : (
              "Needed for Active Directory, Windows and multi-host labs. Install a hypervisor."
            )
          }
          hint={vmProvider ? freeHint("vm") : undefined}
          actions={
            !vmApplicable ? (
              <Button variant="outline" size="sm" onClick={() => onNavigate("server")}>
                Use a server
              </Button>
            ) : vmProvider ? (
              <>
                {lowFor("vm") && (
                  <Button variant="ghost" size="sm" onClick={() => onNavigate("server")}>
                    Use a server
                  </Button>
                )}
                {testBtn("vm")}
              </>
            ) : (
              <Button variant="learn" size="sm" onClick={() => fix(hasHypervisor ? "vagrant" : "vm")}>
                Fix
              </Button>
            )
          }
          testing={testing === "vm"}
          onTestDone={refreshLast}
        />
      </Panel>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {/* Running now */}
        <Panel>
          <PanelHeader
            title="Running now"
            action={labMem > 0 ? <span className="text-[11.5px] tabular-nums text-muted-foreground">{formatBytes(labMem)} in use</span> : undefined}
          />
          {workloads === null ? (
            <ListSkeleton />
          ) : workloads.length === 0 ? (
            <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">Nothing running.</p>
          ) : (
            workloads.map((w) => {
              const key = `${w.kind}:${w.id}`;
              const name = w.id === "selftest" ? "Setup test" : (titles[w.id] ?? w.id);
              const meta =
                w.kind === "docker"
                  ? `${w.count} container${w.count === 1 ? "" : "s"}${w.memBytes ? ` · ${formatBytes(w.memBytes)}` : ""}`
                  : `${w.count} VM${w.count === 1 ? "" : "s"}${w.provider ? ` · ${PROVIDER_LABELS[w.provider] ?? w.provider}` : ""}`;
              return (
                <div key={key} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
                  {w.kind === "docker" ? (
                    <Container className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Server className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium">{name}</p>
                    <p className="text-[11.5px] tabular-nums text-muted-foreground">{meta}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => stop(w)} disabled={stopping !== null}>
                    {stopping === key ? (
                      <>
                        <Spinner className="size-3.5" /> Stopping…
                      </>
                    ) : (
                      <>
                        <Square className="size-3" /> Stop
                      </>
                    )}
                  </Button>
                </div>
              );
            })
          )}
        </Panel>

        {/* Downloads */}
        <Panel>
          <PanelHeader
            title="Downloads"
            action={
              storage && storeItems.length > 0 && !confirmClean ? (
                <Button variant="outline" size="sm" onClick={() => setConfirmClean(true)} disabled={cleaning}>
                  <Trash2 className="size-3.5" /> Clean up
                </Button>
              ) : undefined
            }
          />
          {storage === null ? (
            <ListSkeleton />
          ) : (
            <>
              <button
                onClick={() => setShowStorage((v) => !v)}
                disabled={storeItems.length === 0}
                className="flex w-full items-center gap-3 border-b border-border px-3.5 py-2.5 text-left last:border-b-0 enabled:hover:bg-muted/40"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    showStorage && "rotate-90",
                    storeItems.length === 0 && "opacity-0",
                  )}
                />
                <div className="min-w-0 flex-1 text-[12.5px]">
                  <p className="font-medium">{storeItems.length ? `${formatBytes(storeTotal)} of lab downloads` : "No lab downloads yet"}</p>
                  <p className="text-[11.5px] text-muted-foreground">
                    {storage.images.length} container image{storage.images.length === 1 ? "" : "s"} · {storage.boxes.length} VM image
                    {storage.boxes.length === 1 ? "" : "s"}
                  </p>
                </div>
              </button>
              {showStorage &&
                storeItems.map((it) => (
                  <div key={it.name} className="flex items-center gap-3 border-b border-border py-1.5 pr-3.5 pl-10 text-[12px] last:border-b-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">{it.name}</span>
                    <span className="tabular-nums text-muted-foreground">{formatBytes(it.bytes)}</span>
                  </div>
                ))}
              {confirmClean && (
                <div className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/30 px-3.5 py-3">
                  <p className="min-w-0 flex-1 text-[12px]">
                    Remove {formatBytes(storeTotal)}? Labs download what they need again on their next start. Anything in use stays.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setConfirmClean(false)} disabled={cleaning}>
                      Cancel
                    </Button>
                    <Button variant="destructive" size="sm" onClick={clean} disabled={cleaning}>
                      {cleaning ? (
                        <>
                          <Spinner className="size-3.5" /> Removing…
                        </>
                      ) : (
                        "Remove"
                      )}
                    </Button>
                  </div>
                </div>
              )}
              {freed !== null && !confirmClean && (
                <p className="border-t border-border px-3.5 py-2 text-[12px] text-muted-foreground">
                  {freed > 0 ? `Freed ${formatBytes(freed)}.` : "Nothing could be removed (all in use)."}
                </p>
              )}
            </>
          )}
        </Panel>
      </div>

      {/* Tool versions, for people who want them */}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Details
        </summary>
        <Panel className="mt-2.5">
          <DetailRow
            name="Container engine"
            value={report.dockerEngine ? engineName(report.dockerEngine) : report.dockerRunning ? "running" : "not running"}
            bad={!report.dockerRunning}
          />
          <DetailRow name="Docker CLI" value={ver(report.docker)} bad={!report.docker.installed} />
          <DetailRow name="Docker Compose" value={ver(report.dockerCompose)} bad={!report.dockerCompose.installed} />
          <DetailRow name="Vagrant" value={ver(report.vagrant)} bad={hasHypervisor && !report.vagrant.installed} />
          {hypervisors.map((p) => (
            <DetailRow
              key={p.provider}
              name={providerLabel(p)}
              value={
                p.hypervisor === true
                  ? p.plugin
                    ? p.pluginInstalled
                      ? `installed · ${p.plugin}`
                      : `plugin ${p.plugin} missing`
                    : "installed"
                  : p.hypervisor === false
                    ? "not installed"
                    : "built in"
              }
              bad={p.hypervisor === true && !p.pluginInstalled}
            />
          ))}
          <DetailRow name={report.pkgManager.name} value={report.pkgManager.installed ? "installed" : "not installed"} bad={!report.pkgManager.installed} />
        </Panel>
      </details>
    </div>
  );
}
