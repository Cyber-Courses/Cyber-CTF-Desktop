"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Container, Cpu, HardDrive, MemoryStick, Wrench } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { EngineMark, engineName } from "@/features/machine/setup-steps";
import { machineMetrics, machineOpenSetup, type MachineMetrics, type ProviderStatus, type SystemReport, type Tool } from "@/lib/tauri";
import { getLastTest, getVmProvider, type LastTest } from "@/lib/settings";
import { providerLabel, usableHypervisors } from "@/features/machine/hypervisors";
import { cn } from "@/lib/utils";
import { DetailRow, LabKind, LabTypeRow, Stat } from "@/features/machine/machine-parts";
import { TypeIcon } from "@/components/ui/type-icon";
import { formatAgo, formatBytes, formatUptime } from "@/lib/format";
import { DownloadsPanel } from "@/features/machine/downloads-panel";
import { RunningNowPanel } from "@/features/machine/running-now-panel";
import { HypervisorLogo } from "@/features/machine/hypervisor-logo";

// ---------- formatting ----------

/** Strip the tool name from `docker --version`-style output, keep the version number. */
const ver = (t: Tool) => (t.installed ? (t.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "installed") : "not installed");
const OS_NAME: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

/** Free memory each lab type wants to start comfortably. */
const WANT_FREE = { docker: 2e9, vm: 8e9 };

// ---------- screen ----------

/** Under this much free space the Machine page warns: a lab image plus the attack box needs more. */
const LOW_DISK_BYTES = 20 * 1024 ** 3;

export function MachineScreen({
  report,
  onRefresh,
  onNavigate,
}: {
  report: SystemReport;
  onRefresh: () => void | Promise<void>;
  onNavigate: (tab: "cloud" | "server") => void;
}) {
  // Re-read the machine when the window regains focus: the user may have just installed Docker or
  // a hypervisor in the setup window (or externally), and the setup status would otherwise stay
  // stale until a restart. A ref keeps the handler current without re-subscribing each render.
  const refresh = useRef(onRefresh);
  useEffect(() => {
    refresh.current = onRefresh;
  }, [onRefresh]);
  useEffect(() => {
    const onFocus = () => void refresh.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Live usage, with the last minute of history for the sparklines.
  const [m, setM] = useState<MachineMetrics | null>(null);
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; disk: number[] }>({ cpu: [], mem: [], disk: [] });
  useEffect(() => {
    let alive = true;
    // One metrics read at a time: on a busy machine the read can take a moment, and the 2.5s
    // interval must not stack a second read on top of one still running.
    let reading = false;
    const push = (a: number[], v: number) => [...a, v].slice(-24);
    const tick = () => {
      if (reading) return;
      reading = true;
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
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

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
    // Bumping "now" also refreshes the running list (a test may have started or stopped things).
    setNow(Date.now());
  };

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
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const diskPct = m && m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.75rem] font-medium",
            needsSetup ? "border-amber-500/30 text-amber-500" : "border-emerald-500/30 text-emerald-500",
          )}
        >
          <span className={cn("size-1.5 rounded-full", needsSetup ? "bg-amber-500" : "bg-emerald-500")} />
          {needsSetup ? `${needsSetup} lab ${needsSetup === 1 ? "type needs" : "types need"} setup` : "Ready for labs"}
        </span>
        <span className="text-[0.75rem] text-muted-foreground">
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

      {/* Low disk: labs and the attack box are several GB each, so say so before a download fails. */}
      {m && m.diskTotal > 0 && (diskPct >= 90 || m.diskTotal - m.diskUsed < LOW_DISK_BYTES) && (
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-sm text-amber-200">
          <p className="font-medium text-amber-300">Low disk space</p>
          <p className="mt-1 text-[0.8125rem] text-amber-200/80">
            Only {formatBytes(m.diskTotal - m.diskUsed)} free. The attack box alone is about 3.4 GB, and each lab image adds more. Free up space before you
            start a lab.
          </p>
        </div>
      )}

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
          icon={<HypervisorLogo provider={vmProvider?.provider} />}
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
        <RunningNowPanel refreshKey={now} />
        <DownloadsPanel />
      </div>

      {/* Tool versions, for people who want them */}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.78125rem] text-muted-foreground hover:text-foreground">
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
