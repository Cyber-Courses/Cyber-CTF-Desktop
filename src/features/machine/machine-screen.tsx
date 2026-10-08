"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Container, TriangleAlert, Wrench } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { EngineMark, engineName } from "@/features/machine/setup-steps";
import { machineMetrics, machineOpenSetup, type MachineMetrics, type ProviderStatus, type SystemReport, type Tool } from "@/lib/tauri";
import { getLastTest, getVmProvider, type LastTest } from "@/lib/settings";
import { providerLabel, usableHypervisors } from "@/features/machine/hypervisors";
import { CalloutRow, DetailRow, LabKind, LabTypeRow, StatCard } from "@/features/machine/machine-parts";
import { SetupChecklist } from "@/features/machine/setup-checklist";
import { PageHeader, StatusStrip } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { StatusDot } from "@/components/ui/status-pill";
import { TypeIcon } from "@/components/ui/type-icon";
import { formatAgo, formatBytes, formatUptime } from "@/lib/format";
import { DownloadsPanel } from "@/features/machine/downloads-panel";
import { RunningNowPanel } from "@/features/machine/running-now-panel";
import { HypervisorLogo } from "@/features/machine/hypervisor-logo";
import { ignore, tell } from "@/lib/failure";

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

  // Live usage (the stat cards show meters; the Overview keeps the sparkline history).
  const [m, setM] = useState<MachineMetrics | null>(null);
  useEffect(() => {
    let alive = true;
    // One metrics read at a time: on a busy machine the read can take a moment, and the 2.5s
    // interval must not stack a second read on top of one still running.
    let reading = false;
    const tick = () => {
      if (reading) return;
      reading = true;
      machineMetrics()
        .then((x) => {
          if (alive) setM(x);
        })
        .catch(ignore("polled again in a moment"))
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

  // Health (usage, engines, what runs) or Setup (the guided steps, done or not).
  const [view, setView] = useState<"health" | "setup">("health");

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
      <span className="text-destructive">last test failed {formatAgo(t.at, now)}</span>
    );

  const dockerReady = report.docker.installed && report.dockerRunning;
  const hypervisors = usableHypervisors(report);
  const vmReadyList: ProviderStatus[] = report.vmProviders.filter((p) => !p.remote && p.available && p.hypervisor !== false);
  const preferred = getVmProvider();
  const vmProvider = vmReadyList.find((p) => p.provider === preferred) ?? vmReadyList[0] ?? null;
  const vmApplicable = hypervisors.length > 0;
  const hasHypervisor = hypervisors.some((p) => p.hypervisor === true);
  // A hypervisor with Vagrant and its plugin in place that still can't run (no /dev/kvm, not in
  // the kvm group): its own reason, since installing Vagrant again wouldn't help.
  const blocked = report.vagrant.installed
    ? hypervisors.find((p) => p.hypervisor === true && (!p.plugin || p.pluginInstalled) && !p.available && p.reason)
    : undefined;
  const blockedReason = blocked?.reason ? `${blocked.reason.charAt(0).toUpperCase()}${blocked.reason.slice(1)}.` : null;

  const fix = (step: string) => machineOpenSetup(step).catch(tell("Couldn't open machine setup"));
  const testBtn = (kind: LabKind) => (
    <Button variant="outline" size="xs" onClick={() => setTesting(testing === kind ? null : kind)}>
      {testing === kind ? "Hide test" : "Test"}
    </Button>
  );

  const needsSetup = (!dockerReady ? 1 : 0) + (vmApplicable && !vmProvider ? 1 : 0);
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const diskPct = m && m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Machine"
        lead={
          <>
            What this computer can run, and what it is running now.
            <StatusStrip className="mt-2.5">
              <StatusDot tone={needsSetup ? "warn" : "ok"} />
              <b>{needsSetup ? `${needsSetup} lab ${needsSetup === 1 ? "type needs" : "types need"} setup` : "Ready for labs"}</b>
              <span>·</span>
              <span>
                {OS_NAME[report.os] ?? report.os} {report.arch}
              </span>
              {m && (
                <>
                  <span>·</span>
                  <span>up {formatUptime(m.uptimeSecs)}</span>
                </>
              )}
            </StatusStrip>
          </>
        }
        actions={
          <>
            {needsSetup > 0 && (
              <Button size="sm" onClick={() => machineOpenSetup().catch(tell("Couldn't open machine setup"))}>
                <Wrench className="size-3.5" /> Set up this machine
              </Button>
            )}
            <Segmented
              label="Machine view"
              value={view}
              onChange={setView}
              options={[
                { value: "health", label: "Health" },
                { value: "setup", label: "Setup" },
              ]}
            />
          </>
        }
      />

      {view === "setup" ? (
        <SetupChecklist report={report} last={last} onFix={fix} />
      ) : (
        <>
          {/* Live usage */}
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="CPU" detail={m ? `${m.cores} cores` : ""} value={m ? m.cpu : null} meter />
            <StatCard label="Memory" detail={m ? `${formatBytes(m.memUsed)} of ${formatBytes(m.memTotal)}` : ""} value={m ? memPct : null} meter />
            <StatCard label="Disk" detail={m ? `${formatBytes(m.diskUsed)} of ${formatBytes(m.diskTotal)}` : ""} value={m ? diskPct : null} meter />
          </div>

          {/* Low disk: labs and the attack box are several GB each, so say so before a download fails. */}
          {m && m.diskTotal > 0 && (diskPct >= 90 || m.diskTotal - m.diskUsed < LOW_DISK_BYTES) && (
            <CalloutRow tone="warn" icon={<TriangleAlert className="size-4" />} title="Low disk space" meta={`${formatBytes(m.diskTotal - m.diskUsed)} free`}>
              Only {formatBytes(m.diskTotal - m.diskUsed)} free. The attack box alone is about 3.4 GB, and each lab image adds more. Free up space before you
              start a lab.
            </CalloutRow>
          )}

          {/* What can run */}
          <Panel>
            <PanelHeader title="Engines" meta="used by your labs" />
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
              status={
                dockerReady
                  ? last.docker?.result === "fail"
                    ? "Test failed"
                    : "Ready"
                  : report.dockerDenied
                    ? "No permission"
                    : report.docker.installed
                      ? "Engine stopped"
                      : "Needs setup"
              }
              detail={
                dockerReady ? (
                  <>
                    {report.dockerEngine ? engineName(report.dockerEngine) : "Docker"} · {testLine(last.docker)}
                  </>
                ) : report.dockerDenied ? (
                  (report.dockerDeniedHint ?? "Docker is running, but this user may not use it: add yourself to the docker group, then log out and back in.")
                ) : report.docker.installed ? (
                  "A container engine is installed but not running. Start it to run labs."
                ) : (
                  // The engines this OS has (OrbStack is macOS-only; Docker Engine is Linux's own).
                  `No container engine yet. ${report.os === "linux" ? "Docker Engine, Docker Desktop or Colima" : report.os === "macos" ? "Docker Desktop, OrbStack or Colima" : "Docker Desktop"} all work.`
                )
              }
              hint={dockerReady ? freeHint("docker") : undefined}
              actions={
                dockerReady ? (
                  testBtn("docker")
                ) : report.dockerDenied ? null : (
                  <Button variant="outline" size="xs" onClick={() => fix("docker")}>
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
                    {providerLabel(vmProvider, report.os)}
                    {vmReadyList.length > 1 && !preferred ? " (automatic, change in Settings)" : ""} · {testLine(last.vm)}
                  </>
                ) : blockedReason ? (
                  blockedReason
                ) : hasHypervisor ? (
                  "Vagrant or the hypervisor's Vagrant plugin is missing."
                ) : (
                  "Needed for Active Directory, Windows and multi-host labs. Install a hypervisor."
                )
              }
              hint={vmProvider ? freeHint("vm") : undefined}
              actions={
                !vmApplicable ? (
                  <Button variant="outline" size="xs" onClick={() => onNavigate("server")}>
                    Use a server
                  </Button>
                ) : vmProvider ? (
                  <>
                    {lowFor("vm") && (
                      <Button variant="ghost" size="xs" onClick={() => onNavigate("server")}>
                        Use a server
                      </Button>
                    )}
                    {testBtn("vm")}
                  </>
                ) : blockedReason ? (
                  <Button variant="outline" size="xs" onClick={() => onNavigate("server")}>
                    Use a server
                  </Button>
                ) : (
                  <Button variant="outline" size="xs" onClick={() => fix(hasHypervisor ? "vagrant" : "vm")}>
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
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground">
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
                  name={providerLabel(p, report.os)}
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
            {report.targets.length > 0 && (
              <Panel className="mt-2.5">
                <PanelHeader title="Where labs can run (Isoloom)" />
                {report.targets.map((t) => (
                  <DetailRow key={`${t.target}/${t.cloud ?? ""}`} name={t.cloud ? `${t.target} · ${t.cloud}` : t.target} value={t.summary} bad={!t.ready} />
                ))}
              </Panel>
            )}
          </details>
        </>
      )}
    </div>
  );
}
