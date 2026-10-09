"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Cloud, ExternalLink, Play, RotateCcw, Server, TriangleAlert } from "lucide-react";
import { KeyValue, Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot, StatusPill } from "@/components/ui/status-pill";
import { TypeIcon } from "@/components/ui/type-icon";
import { LabRow, emulatorReady } from "@/features/labs/lab-row";
import { useLabs, type Lab } from "@/features/labs/use-labs";
import { useLabActions } from "@/features/labs/use-lab-actions";
import { CalloutRow, StatCard } from "@/features/machine/machine-parts";
import { StepRow } from "@/features/machine/step-row";
import { getLastRun } from "@/lib/last-run";
import { formatAgo } from "@/lib/format";
import { operationLabel, useActiveOperations } from "@/lib/deploy-store";
import { assessRam } from "@/features/home/capacity";
import { machineMetrics, machineOpenSetup, type ActiveOperation, type AuthStatus, type MachineMetrics, type SystemReport } from "@/lib/tauri";
import { ignore, tell } from "@/lib/failure";
import { useFormat, useT, type T } from "@/lib/i18n";

type Tab = "labs" | "machine" | "setup" | "server" | "cloud" | "settings";

const HISTORY = 20;
const push = (a: number[], v: number) => [...a, v].slice(-HISTORY);

/** "Good morning / afternoon / evening" from the local hour. */
function greeting(t: T, hour: number) {
  return t(hour < 12 ? "home.greeting.morning" : hour < 18 ? "home.greeting.afternoon" : "home.greeting.evening");
}

/** The second column of the Overview: what is being deployed right now, step by step. */
function DeployPanel({ ops, labs, onOpen }: { ops: ActiveOperation[]; labs: Lab[]; onOpen: (slug: string) => void }) {
  const t = useT();
  const one = ops.length === 1 ? ops[0] : null;
  const labOf = (id: string) => labs.find((l) => l.id === id);
  const oneLab = one ? labOf(one.labId) : undefined;
  return (
    <Panel>
      <PanelHeader
        title={
          <>
            <StatusDot tone="warn" pulse />
            <span className="truncate">{one ? (oneLab?.slug ?? one.labId) : t("home.deploy.inProgress")}</span>
          </>
        }
        meta={one ? operationLabel(one).replace(/…$/, "").toLowerCase() : t("home.running.labs", { count: ops.length })}
        action={
          oneLab && (
            <Button variant="ghost" size="xs" onClick={() => onOpen(oneLab.slug)}>
              {t("home.deploy.view")}
            </Button>
          )
        }
      />
      <div className="py-1.5">
        {ops.map((o) => {
          const lab = labOf(o.labId);
          return (
            <StepRow
              key={o.labId}
              state="run"
              label={o.step ?? operationLabel(o)}
              detail={one ? undefined : (lab?.title ?? o.labId)}
              meta={o.machine?.replace(/^isoloom-/, "") ?? t("home.deploy.running")}
              action={
                !one &&
                lab && (
                  <Button variant="ghost" size="xs" onClick={() => onOpen(lab.slug)}>
                    {t("home.deploy.view")}
                  </Button>
                )
              }
            />
          );
        })}
      </div>
    </Panel>
  );
}

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
  const { labs, statuses, refreshStatus } = useLabs(auth?.loggedIn ?? false);
  const { runs, launch, stop, resume } = useLabActions(refreshStatus);
  const ops = useActiveOperations();
  const [metrics, setMetrics] = useState<MachineMetrics | null>(null);
  // A rolling window of the 3 s polls, for the stat card sparklines.
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; disk: number[] }>({ cpu: [], mem: [], disk: [] });
  // "Now" for the "last run" labels and the greeting, taken once per visit.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const tick = () =>
      machineMetrics()
        .then((m) => {
          if (!alive) return;
          setMetrics(m);
          setHist((h) => ({
            cpu: push(h.cpu, m.cpu),
            mem: push(h.mem, m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0),
            disk: push(h.disk, m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0),
          }));
        })
        .catch(ignore("polled again in a moment"));
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Unknown until the machine report is in: no "set up" call to action for a Docker that is
  // simply not probed yet.
  const dockerReady = report ? report.docker.installed && report.dockerRunning : null;
  const running = (labs ?? []).filter((l) => statuses[l.id]?.running);
  // The running labs' own containers: the engine's total also counts the player's other projects.
  const labContainers = running
    .filter((l) => l.runtime?.runtime === "DOCKER" && (statuses[l.id]?.place ?? "container") === "container")
    .reduce((n, l) => n + (statuses[l.id]?.machines.length ?? 0), 0);
  const preview = (labs ?? []).slice(0, 6);
  const activeOps = [...ops.values()];

  // "Jump back in": recently launched labs (local history), most recent first, not already running.
  const recent = (labs ?? [])
    .map((lab) => ({ lab, ts: getLastRun(lab.id) }))
    .filter((r): r is { lab: Lab; ts: number } => r.ts !== null && !statuses[r.lab.id]?.running)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 3);

  const name = auth?.name?.split(" ")[0];
  const memPct = metrics && metrics.memTotal ? (metrics.memUsed / metrics.memTotal) * 100 : null;
  const diskPct = metrics && metrics.diskTotal ? (metrics.diskUsed / metrics.diskTotal) * 100 : null;
  const capacity = metrics ? assessRam(metrics.memTotal) : null;
  const hello = greeting(t, new Date(now).getHours());

  const heroStatus =
    dockerReady === null
      ? t("home.status.checking")
      : !dockerReady
        ? t("home.status.setUpDocker")
        : running.length > 0
          ? t("home.status.running", { count: running.length })
          : t("home.status.ready");

  const labRow = (lab: Lab) => (
    <LabRow
      key={lab.id}
      lab={lab}
      status={statuses[lab.id]}
      busy={!!runs[lab.id]?.busy}
      operation={runs[lab.id]?.op}
      loggedIn={auth?.loggedIn ?? false}
      hostArch={report?.arch ?? ""}
      emulates={emulatorReady(report)}
      onOpen={() => onNavigate("labs", lab.slug)}
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
        lead={heroStatus}
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
          value={memPct}
          history={hist.mem}
        />
        <StatCard
          label={t("home.stats.disk")}
          detail={metrics ? t("home.stats.usage", { used: gb(metrics.diskUsed), total: gb(metrics.diskTotal) }) : ""}
          value={diskPct}
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
          <DeployPanel ops={activeOps} labs={labs ?? []} onOpen={(slug) => onNavigate("labs", slug)} />
        ) : (
          <Panel>
            <PanelHeader
              title={t("home.machine.title")}
              action={
                <Button variant="ghost" size="xs" onClick={() => onNavigate("machine")}>
                  {t("home.machine.open")} <ArrowRight />
                </Button>
              }
            />
            <KeyValue k={t("home.machine.dockerEngine")}>
              {report ? (
                <StatusPill tone={report.dockerRunning ? "ok" : "warn"}>
                  {report.dockerRunning ? t("home.machine.running") : t("home.machine.stopped")}
                </StatusPill>
              ) : (
                "…"
              )}
            </KeyValue>
            <KeyValue k={t("home.machine.containers")}>{metrics ? `${metrics.containers}` : dockerReady ? "0" : t("home.machine.none")}</KeyValue>
            <KeyValue k={t("home.machine.cores")}>{metrics ? `${metrics.cores}` : "…"}</KeyValue>
          </Panel>
        )}
      </div>

      {recent.length > 0 && (
        <Panel>
          <PanelHeader title={t("home.jumpBack.title")} meta={t("home.jumpBack.meta")} />
          {recent.map(({ lab, ts }) => (
            <div
              key={lab.id}
              className="flex h-13 items-center gap-3.5 border-t border-border px-4 text-[0.8125rem] transition-colors first:border-t-0 hover:bg-glass"
            >
              <TypeIcon>
                <RotateCcw className="size-3.5" />
              </TypeIcon>
              <button onClick={() => onNavigate("labs", lab.slug)} className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium text-foreground">{lab.title}</span>
                <span className="block truncate font-mono text-[0.6875rem] text-faint">
                  {t("home.jumpBack.lastRun", { slug: lab.slug, ago: formatAgo(ts, now) })}
                </span>
              </button>
              <Button
                size="xs"
                // A shut-down or paused lab comes back as it was; a fresh launch would
                // start over on top of its kept machines.
                onClick={() => (statuses[lab.id]?.parked ? resume(lab) : launch(lab, undefined, undefined, report))}
                disabled={!!runs[lab.id]?.busy || !(auth?.loggedIn ?? false) || !lab.runtime}
              >
                {runs[lab.id]?.busy ? (
                  <Spinner className="size-3" />
                ) : (
                  <>
                    <Play /> {t("home.jumpBack.resume")}
                  </>
                )}
              </Button>
            </div>
          ))}
        </Panel>
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
