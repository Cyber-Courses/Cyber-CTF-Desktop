"use client";

import { useEffect, useRef, useState } from "react";
import { TriangleAlert, Wrench } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { machineOpenSetup, type SystemReport } from "@/lib/tauri";
import { getLastTest, getVmProvider, type LastTest } from "@/lib/settings";
import { CalloutRow, LabKind, StatCard } from "@/features/machine/machine-parts";
import { DockerLabRow, VmLabRow } from "@/features/machine/lab-type-rows";
import { MachineDetails } from "@/features/machine/machine-details";
import { OS_NAME, dockerState, isLowDisk, setupCount, usage, vmSetup } from "@/features/machine/machine-status";
import { SetupChecklist } from "@/features/machine/setup-checklist";
import { PageHeader, StatusStrip } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { StatusDot } from "@/components/ui/status-pill";
import { DownloadsPanel } from "@/features/machine/downloads-panel";
import { RunningNowPanel } from "@/features/machine/running-now-panel";
import { useMachineFormat } from "@/features/machine/use-machine-format";
import { useMachineMetrics } from "@/features/machine/use-machine-metrics";
import { useNow } from "@/lib/use-now";
import { tell } from "@/lib/failure";
import { useT } from "@/lib/i18n";

const lastTests = (): Record<LabKind, LastTest | null> => ({ docker: getLastTest("docker"), vm: getLastTest("vm") });

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
  const { metrics: m } = useMachineMetrics(2500, { serial: true });

  // Health (usage, engines, what runs) or Setup (the guided steps, done or not).
  const [view, setView] = useState<"health" | "setup">("health");

  // Last self-test per lab type (kept locally), and which test is open inline.
  const [last, setLast] = useState(lastTests);
  const [testing, setTesting] = useState<LabKind | null>(null);
  const [now, touchNow] = useNow(30_000);
  const refreshLast = () => {
    setLast(lastTests());
    // Bumping "now" also refreshes the running list (a test may have started or stopped things).
    touchNow();
  };

  const docker = dockerState(report, last.docker);
  const vm = vmSetup(report, getVmProvider(), last.vm);
  const needsSetup = setupCount(docker, vm.state);
  const use = m ? usage(m) : null;

  const fix = (step: string) => machineOpenSetup(step).catch(tell(t("machine.errors.openSetup")));
  const rowProps = (kind: LabKind) => ({
    report,
    last: last[kind],
    now,
    memFree: use?.memFree ?? null,
    testing: testing === kind,
    onToggleTest: () => setTesting(testing === kind ? null : kind),
    onTestDone: refreshLast,
    onFix: fix,
  });

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
              value={use ? use.memPct : null}
              meter
            />
            <StatCard
              label={t("machine.screen.disk")}
              detail={m ? t("machine.screen.usedOf", { used: fmt.bytes(m.diskUsed), total: fmt.bytes(m.diskTotal) }) : ""}
              value={use ? use.diskPct : null}
              meter
            />
          </div>

          {/* Low disk: labs and the attack box are several GB each, so say so before a download fails. */}
          {m && use && isLowDisk(m) && (
            <CalloutRow
              tone="warn"
              icon={<TriangleAlert className="size-4" />}
              title={t("machine.screen.lowDisk.title")}
              meta={t("machine.screen.lowDisk.meta", { free: fmt.bytes(use.diskFree) })}
            >
              {t("machine.screen.lowDisk.body", { free: fmt.bytes(use.diskFree) })}
            </CalloutRow>
          )}

          {/* What can run */}
          <Panel>
            <PanelHeader title={t("machine.screen.engines")} meta={t("machine.screen.enginesMeta")} />
            <DockerLabRow {...rowProps("docker")} />
            <VmLabRow {...rowProps("vm")} vm={vm} onUseServer={() => onNavigate("server")} />
          </Panel>

          <div className="grid items-start gap-5 lg:grid-cols-2">
            <RunningNowPanel refreshKey={now} />
            <DownloadsPanel />
          </div>

          <MachineDetails report={report} hypervisors={vm.hypervisors} hasHypervisor={vm.hasHypervisor} />
        </>
      )}
    </div>
  );
}
