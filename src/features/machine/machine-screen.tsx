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
import { DownloadsPanel } from "@/features/machine/downloads-panel";
import { RunningNowPanel } from "@/features/machine/running-now-panel";
import { HypervisorLogo } from "@/features/machine/hypervisor-logo";
import { useMachineFormat } from "@/features/machine/use-machine-format";
import { ignore, tell } from "@/lib/failure";
import { useT, type T } from "@/lib/i18n";

// ---------- formatting ----------

/** Strip the tool name from `docker --version`-style output, keep the version number. */
const ver = (tool: Tool, t: T) =>
  tool.installed ? (tool.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? t("machine.screen.detail.installed")) : t("machine.screen.detail.notInstalled");
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
  const t = useT();
  const fmt = useMachineFormat();
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
      ? t(kind === "vm" ? "machine.screen.freeHintVm" : "machine.screen.freeHintDocker", {
          want: fmt.bytes(WANT_FREE[kind]),
          free: fmt.bytes(Math.max(0, memFree!)),
        })
      : undefined;
  const testLine = (test: LastTest | null) =>
    !test ? (
      <span>{t("machine.screen.notTestedYet")}</span>
    ) : test.result === "ok" ? (
      <span>{t("machine.screen.tested", { ago: fmt.ago(test.at, now) })}</span>
    ) : (
      <span className="text-destructive">{t("machine.screen.lastTestFailed", { ago: fmt.ago(test.at, now) })}</span>
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

  const fix = (step: string) => machineOpenSetup(step).catch(tell(t("machine.errors.openSetup")));
  const testBtn = (kind: LabKind) => (
    <Button variant="outline" size="xs" onClick={() => setTesting(testing === kind ? null : kind)}>
      {testing === kind ? t("machine.screen.hideTest") : t("machine.screen.test")}
    </Button>
  );

  const needsSetup = (!dockerReady ? 1 : 0) + (vmApplicable && !vmProvider ? 1 : 0);
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const diskPct = m && m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("machine.screen.title")}
        lead={
          <>
            {t("machine.screen.lead")}
            <StatusStrip className="mt-2.5">
              <StatusDot tone={needsSetup ? "warn" : "ok"} />
              <b>{needsSetup ? t("machine.screen.needsSetup", { count: needsSetup }) : t("machine.screen.readyForLabs")}</b>
              <span>·</span>
              <span>
                {OS_NAME[report.os] ?? report.os} {report.arch}
              </span>
              {m && (
                <>
                  <span>·</span>
                  <span>{t("machine.screen.uptime", { uptime: fmt.uptime(m.uptimeSecs) })}</span>
                </>
              )}
            </StatusStrip>
          </>
        }
        actions={
          <>
            {needsSetup > 0 && (
              <Button size="sm" onClick={() => machineOpenSetup().catch(tell(t("machine.errors.openSetup")))}>
                <Wrench className="size-3.5" /> {t("machine.screen.setUp")}
              </Button>
            )}
            <Segmented
              label={t("machine.screen.viewLabel")}
              value={view}
              onChange={setView}
              options={[
                { value: "health", label: t("machine.screen.viewHealth") },
                { value: "setup", label: t("machine.screen.viewSetup") },
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
            <StatCard label={t("machine.screen.cpu")} detail={m ? t("machine.screen.cores", { count: m.cores }) : ""} value={m ? m.cpu : null} meter />
            <StatCard
              label={t("machine.screen.memory")}
              detail={m ? t("machine.screen.usedOf", { used: fmt.bytes(m.memUsed), total: fmt.bytes(m.memTotal) }) : ""}
              value={m ? memPct : null}
              meter
            />
            <StatCard
              label={t("machine.screen.disk")}
              detail={m ? t("machine.screen.usedOf", { used: fmt.bytes(m.diskUsed), total: fmt.bytes(m.diskTotal) }) : ""}
              value={m ? diskPct : null}
              meter
            />
          </div>

          {/* Low disk: labs and the attack box are several GB each, so say so before a download fails. */}
          {m && m.diskTotal > 0 && (diskPct >= 90 || m.diskTotal - m.diskUsed < LOW_DISK_BYTES) && (
            <CalloutRow
              tone="warn"
              icon={<TriangleAlert className="size-4" />}
              title={t("machine.screen.lowDisk.title")}
              meta={t("machine.screen.lowDisk.meta", { free: fmt.bytes(m.diskTotal - m.diskUsed) })}
            >
              {t("machine.screen.lowDisk.body", { free: fmt.bytes(m.diskTotal - m.diskUsed) })}
            </CalloutRow>
          )}

          {/* What can run */}
          <Panel>
            <PanelHeader title={t("machine.screen.engines")} meta={t("machine.screen.enginesMeta")} />
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
              title={t("machine.screen.containerLabs")}
              tone={dockerReady ? (last.docker?.result === "fail" ? "fail" : "ok") : "warn"}
              status={
                dockerReady
                  ? last.docker?.result === "fail"
                    ? t("machine.screen.status.testFailed")
                    : t("machine.screen.status.ready")
                  : report.dockerDenied
                    ? t("machine.screen.status.noPermission")
                    : report.docker.installed
                      ? t("machine.screen.status.engineStopped")
                      : t("machine.screen.status.needsSetup")
              }
              detail={
                dockerReady ? (
                  <>
                    {report.dockerEngine ? engineName(report.dockerEngine) : "Docker"} · {testLine(last.docker)}
                  </>
                ) : report.dockerDenied ? (
                  (report.dockerDeniedHint ?? t("machine.screen.docker.denied"))
                ) : report.docker.installed ? (
                  t("machine.screen.docker.stopped")
                ) : // The engines this OS has (OrbStack is macOS-only; Docker Engine is Linux's own).
                report.os === "linux" ? (
                  t("machine.screen.docker.noEngineLinux")
                ) : report.os === "macos" ? (
                  t("machine.screen.docker.noEngineMacos")
                ) : (
                  t("machine.screen.docker.noEngineWindows")
                )
              }
              hint={dockerReady ? freeHint("docker") : undefined}
              actions={
                dockerReady ? (
                  testBtn("docker")
                ) : report.dockerDenied ? null : (
                  <Button variant="outline" size="xs" onClick={() => fix("docker")}>
                    {t("machine.screen.fix")}
                  </Button>
                )
              }
              testing={testing === "docker"}
              onTestDone={refreshLast}
            />
            <LabTypeRow
              kind="vm"
              icon={<HypervisorLogo provider={vmProvider?.provider} />}
              title={t("machine.screen.vmLabs")}
              tone={!vmApplicable ? "muted" : vmProvider ? (last.vm?.result === "fail" ? "fail" : "ok") : "warn"}
              status={
                !vmApplicable
                  ? t("machine.screen.status.notOnThisMachine")
                  : vmProvider
                    ? last.vm?.result === "fail"
                      ? t("machine.screen.status.testFailed")
                      : t("machine.screen.status.ready")
                    : t("machine.screen.status.needsSetup")
              }
              detail={
                !vmApplicable ? (
                  t("machine.screen.vm.notApplicable")
                ) : vmProvider ? (
                  <>
                    {providerLabel(vmProvider, report.os)}
                    {vmReadyList.length > 1 && !preferred ? t("machine.screen.vm.automatic") : ""} · {testLine(last.vm)}
                  </>
                ) : blockedReason ? (
                  blockedReason
                ) : hasHypervisor ? (
                  t("machine.screen.vm.vagrantMissing")
                ) : (
                  t("machine.screen.vm.needHypervisor")
                )
              }
              hint={vmProvider ? freeHint("vm") : undefined}
              actions={
                !vmApplicable ? (
                  <Button variant="outline" size="xs" onClick={() => onNavigate("server")}>
                    {t("machine.screen.useServer")}
                  </Button>
                ) : vmProvider ? (
                  <>
                    {lowFor("vm") && (
                      <Button variant="ghost" size="xs" onClick={() => onNavigate("server")}>
                        {t("machine.screen.useServer")}
                      </Button>
                    )}
                    {testBtn("vm")}
                  </>
                ) : blockedReason ? (
                  <Button variant="outline" size="xs" onClick={() => onNavigate("server")}>
                    {t("machine.screen.useServer")}
                  </Button>
                ) : (
                  <Button variant="outline" size="xs" onClick={() => fix(hasHypervisor ? "vagrant" : "vm")}>
                    {t("machine.screen.fix")}
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
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> {t("machine.screen.details")}
            </summary>
            <Panel className="mt-2.5">
              <DetailRow
                name={t("machine.screen.detail.containerEngine")}
                value={
                  report.dockerEngine
                    ? engineName(report.dockerEngine)
                    : report.dockerRunning
                      ? t("machine.screen.detail.running")
                      : t("machine.screen.detail.notRunning")
                }
                bad={!report.dockerRunning}
              />
              <DetailRow name="Docker CLI" value={ver(report.docker, t)} bad={!report.docker.installed} />
              <DetailRow name="Docker Compose" value={ver(report.dockerCompose, t)} bad={!report.dockerCompose.installed} />
              <DetailRow name="Vagrant" value={ver(report.vagrant, t)} bad={hasHypervisor && !report.vagrant.installed} />
              {hypervisors.map((p) => (
                <DetailRow
                  key={p.provider}
                  name={providerLabel(p, report.os)}
                  value={
                    p.hypervisor === true
                      ? p.plugin
                        ? p.pluginInstalled
                          ? t("machine.screen.detail.installedWithPlugin", { plugin: p.plugin })
                          : t("machine.screen.detail.pluginMissing", { plugin: p.plugin })
                        : t("machine.screen.detail.installed")
                      : p.hypervisor === false
                        ? t("machine.screen.detail.notInstalled")
                        : t("machine.screen.detail.builtIn")
                  }
                  bad={p.hypervisor === true && !p.pluginInstalled}
                />
              ))}
              <DetailRow
                name={report.pkgManager.name}
                value={report.pkgManager.installed ? t("machine.screen.detail.installed") : t("machine.screen.detail.notInstalled")}
                bad={!report.pkgManager.installed}
              />
            </Panel>
            {report.targets.length > 0 && (
              <Panel className="mt-2.5">
                <PanelHeader title={t("machine.screen.targets")} />
                {report.targets.map((target) => (
                  <DetailRow
                    key={`${target.target}/${target.cloud ?? ""}`}
                    name={target.cloud ? `${target.target} · ${target.cloud}` : target.target}
                    value={target.summary}
                    bad={!target.ready}
                  />
                ))}
              </Panel>
            )}
          </details>
        </>
      )}
    </div>
  );
}
