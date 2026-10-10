"use client";

import { useState } from "react";
import { ArrowRight, Cloud, ExternalLink, Play, Server, TriangleAlert } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { LabRow, emulatorReady } from "@/features/labs/lab-row";
import { useLabs, type Lab } from "@/features/labs/use-labs";
import { useLabActions } from "@/features/labs/use-lab-actions";
import { CalloutRow, StatCard } from "@/features/machine/machine-parts";
import { usage } from "@/features/machine/machine-status";
import { useMachineMetrics } from "@/features/machine/use-machine-metrics";
import { DeployPanel } from "@/features/home/deploy-panel";
import { JumpBackPanel } from "@/features/home/jump-back-panel";
import { MachineSummaryPanel } from "@/features/home/machine-summary-panel";
import { dockerReadiness, greetingKey, heroStatus, labContainerCount, recentLabs, runningLabs } from "@/features/home/home-model";
import { getLastRun } from "@/lib/last-run";
import { useActiveOperations } from "@/lib/deploy-store";
import { assessRam } from "@/features/home/capacity";
import { machineOpenSetup, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { tell } from "@/lib/failure";
import { useFormat, useT } from "@/lib/i18n";

type Tab = "labs" | "machine" | "setup" | "server" | "cloud" | "settings";

export function HomeScreen({
  report,
  auth,
  onNavigate,
}: {
  report: SystemReport | null;
  auth: AuthStatus | null;
  onNavigate: (tab: Tab, slug?: string) => void;
}) {
  const t = useT();
  const format = useFormat();
  /** Gigabytes with one decimal, without a trailing ".0" (19.5, 32). */
  const gb = (bytes: number) => format.number(bytes / 1e9, { maximumFractionDigits: 1, useGrouping: false });
  const loggedIn = auth?.loggedIn ?? false;
  const { labs, statuses, refreshStatus } = useLabs(loggedIn);
  const { runs, launch, stop, resume } = useLabActions(refreshStatus);
  const ops = useActiveOperations();
  // A rolling window of the 3 s polls, for the stat card sparklines.
  const { metrics, history: hist } = useMachineMetrics(3000);
  // "Now" for the "last run" labels and the greeting, taken once per visit.
  const [now] = useState(() => Date.now());

  const dockerReady = dockerReadiness(report);
  const running = runningLabs(labs ?? [], statuses);
  const labContainers = labContainerCount(running, statuses);
  const preview = (labs ?? []).slice(0, 6);
  const activeOps = [...ops.values()];
  const recent = recentLabs(labs ?? [], statuses, getLastRun);

  const name = auth?.name?.split(" ")[0];
  const use = metrics ? usage(metrics) : null;
  const capacity = metrics ? assessRam(metrics.memTotal) : null;
  const hello = t(greetingKey(new Date(now).getHours()));
  const openLab = (slug: string) => onNavigate("labs", slug);

  const labRow = (lab: Lab) => (
    <LabRow
      key={lab.id}
      lab={lab}
      status={statuses[lab.id]}
      busy={!!runs[lab.id]?.busy}
      operation={runs[lab.id]?.op}
      loggedIn={loggedIn}
      hostArch={report?.arch ?? ""}
      emulates={emulatorReady(report)}
      onOpen={() => openLab(lab.slug)}
      onStop={() => stop(lab)}
      onResume={() => resume(lab)}
    />
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          auth?.loggedIn ? (
            name ? (
              <>{t.rich("home.title.named", { em: (s) => <em>{s}</em> }, { greeting: hello, name })}</>
            ) : (
              t("home.title.plain", { greeting: hello })
            )
          ) : (
            <>{t.rich("home.title.welcome", { em: (s) => <em>{s}</em> })}</>
          )
        }
        lead={t(`home.status.${heroStatus(dockerReady, running.length)}`, { count: running.length })}
        actions={
          dockerReady === false ? (
            <Button size="sm" onClick={() => machineOpenSetup().catch(tell(t("home.actions.setUpFailed")))}>
              <Play className="size-3.5" /> {t("home.actions.setUp")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => onNavigate("labs")}>
              {t("home.actions.browse")} <ArrowRight className="size-3.5" />
            </Button>
          )
        }
      />

      {/* Live usage */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t("home.stats.cpu")}
          detail={metrics ? t("home.stats.cores", { cores: metrics.cores }) : ""}
          value={metrics ? metrics.cpu : null}
          history={hist.cpu}
        />
        <StatCard
          label={t("home.stats.memory")}
          detail={metrics ? t("home.stats.usage", { used: gb(metrics.memUsed), total: gb(metrics.memTotal) }) : ""}
          value={use && metrics?.memTotal ? use.memPct : null}
          history={hist.mem}
        />
        <StatCard
          label={t("home.stats.disk")}
          detail={metrics ? t("home.stats.usage", { used: gb(metrics.diskUsed), total: gb(metrics.diskTotal) }) : ""}
          value={use && metrics?.diskTotal ? use.diskPct : null}
          history={hist.disk}
        />
      </div>

      {capacity && capacity.level === "low" && (
        <CalloutRow
          tone="warn"
          icon={<TriangleAlert className="size-4" />}
          title={capacity.title}
          meta={t("home.capacity.total", { total: format.number(capacity.totalGB, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
          actions={
            <>
              <Button variant="outline" size="xs" onClick={() => onNavigate("cloud")}>
                <Cloud /> {t("home.capacity.cloud")}
              </Button>
              <Button variant="outline" size="xs" onClick={() => onNavigate("server")}>
                <Server /> {t("home.capacity.server")}
              </Button>
            </>
          }
        >
          {capacity.detail}
        </CalloutRow>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel>
          <PanelHeader
            title={t("home.running.title")}
            meta={
              <span className="tabular-nums">
                {t("home.running.labs", { count: running.length })}
                {labContainers > 0 ? ` · ${t("home.running.containers", { count: labContainers })}` : ""}
              </span>
            }
          />
          {running.length > 0 ? running.map(labRow) : <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">{t("home.running.empty")}</p>}
        </Panel>

        {activeOps.length > 0 ? (
          <DeployPanel ops={activeOps} labs={labs ?? []} onOpen={openLab} />
        ) : (
          <MachineSummaryPanel report={report} metrics={metrics} dockerReady={dockerReady} onOpen={() => onNavigate("machine")} />
        )}
      </div>

      {recent.length > 0 && (
        <JumpBackPanel
          recent={recent}
          now={now}
          isBusy={(lab) => !!runs[lab.id]?.busy}
          canStart={(lab) => loggedIn && !!lab.runtime}
          onOpen={(lab) => openLab(lab.slug)}
          // A shut-down or paused lab comes back as it was; a fresh launch would start over on
          // top of its kept machines.
          onStart={(lab) => (statuses[lab.id]?.parked ? resume(lab) : launch(lab, undefined, undefined, report))}
        />
      )}

      <Panel>
        <PanelHeader
          title={
            <>
              {t("home.labs.title")} {labs && <span className="font-mono text-[0.6875rem] font-normal text-faint">{labs.length}</span>}
            </>
          }
          action={
            <Button variant="ghost" size="xs" onClick={() => onNavigate("labs")}>
              {t("home.labs.all")} <ArrowRight />
            </Button>
          }
        />
        {!labs ? (
          <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">{t("home.labs.loading")}</p>
        ) : labs.length === 0 ? (
          <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">{t("home.labs.empty")}</p>
        ) : (
          preview.map(labRow)
        )}
      </Panel>

      {!auth?.loggedIn && (
        <p className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
          <ExternalLink className="size-3.5" /> {t("home.signInHint")}
        </p>
      )}
    </div>
  );
}
