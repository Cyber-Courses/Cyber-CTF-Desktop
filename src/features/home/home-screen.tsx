"use client";

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Cloud, Container, Cpu, ExternalLink, Globe, MemoryStick, Play, RotateCcw, Server, TriangleAlert } from "lucide-react";
import { Panel, RailLabel } from "@/components/ui/panel";
import { Meter } from "@/components/ui/meter";
import { Spinner } from "@/components/ui/spinner";
import { LabRow } from "@/features/labs/lab-row";
import { useLabs, type Lab } from "@/features/labs/use-labs";
import { useLabActions } from "@/features/labs/use-lab-actions";
import { useHostedLabs } from "@/features/hosted/use-hosted-labs";
import { getLastRun } from "@/lib/last-run";
import { formatAgo } from "@/lib/format";
import { assessRam } from "@/features/home/capacity";
import { machineMetrics, machineOpenSetup, type AuthStatus, type MachineMetrics, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "labs" | "machine" | "setup" | "server" | "cloud" | "settings";

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

function StatusRow({ name, value, tone }: { name: string; value: string; tone?: "ok" | "warn" | "mut" }) {
  return (
    <div className="flex items-center border-b border-border px-3.5 py-2.5 text-[0.78125rem] last:border-b-0">
      <span className="text-muted-foreground">{name}</span>
      <span className={cn("ml-auto flex items-center gap-1.5", tone === "ok" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : "text-foreground")}>
        {(tone === "ok" || tone === "warn") && <span className={cn("size-1.5 rounded-full", tone === "ok" ? "bg-emerald-500" : "bg-amber-500")} />}
        {value}
      </span>
    </div>
  );
}

function MetricRow({ icon: Icon, label, pct, detail }: { icon: typeof Cpu; label: string; pct: number | null; detail: string }) {
  return (
    <div className="border-b border-border px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2 text-[0.78125rem]">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">{label}</span>
        <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">{detail}</span>
      </div>
      <Meter value={pct ?? 0} className="mt-2" />
    </div>
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
  const { labs, statuses, refreshStatus } = useLabs(auth?.loggedIn ?? false);
  const { busy, launch, stop } = useLabActions(refreshStatus);
  const [metrics, setMetrics] = useState<MachineMetrics | null>(null);
  // "Now" for the "last run" labels, taken once per visit.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const tick = () =>
      machineMetrics()
        .then((m) => alive && setMetrics(m))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // The player's active hosted session (run by Cyber CTF), shown alongside local labs.
  const hosted = useHostedLabs();
  const hostedActive = !!hosted.session && !["FAILED", "STOPPED", "EXPIRED"].includes(hosted.session.state);
  const hostedRunning = hosted.session?.state === "RUNNING";
  const hostedLab = hosted.session && labs ? (labs.find((l) => l.id === hosted.session!.labId) ?? null) : null;

  const dockerReady = report ? report.docker.installed && report.dockerRunning : false;
  const running = (labs ?? []).filter((l) => statuses[l.id]?.running);
  const preview = (labs ?? []).slice(0, 6);

  // "Jump back in": recently launched labs (local history), most recent first, not already running.
  const recent = (labs ?? [])
    .map((lab) => ({ lab, ts: getLastRun(lab.id) }))
    .filter((r): r is { lab: Lab; ts: number } => r.ts !== null && !statuses[r.lab.id]?.running)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 3);

  const name = auth?.name?.split(" ")[0];
  const memPct = metrics ? (metrics.memUsed / metrics.memTotal) * 100 : null;
  const capacity = metrics ? assessRam(metrics.memTotal) : null;

  const heroStatus = !dockerReady
    ? "Set up Docker to start running labs."
    : running.length > 0
      ? `${running.length} lab${running.length > 1 ? "s" : ""} running on this machine.`
      : "This machine is ready. Pick a lab to attack.";

  return (
    <div className="space-y-5">
      {/* ---- Hero ---- */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-gradient-to-br from-[#141414] to-[#0a0a0a] p-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{auth?.loggedIn ? `Welcome back${name ? `, ${name}` : ""}` : "Welcome to Cyber CTF"}</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">{heroStatus}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!dockerReady ? (
            <button
              onClick={() => machineOpenSetup().catch(() => {})}
              className="inline-flex items-center gap-1.5 rounded-lg border border-learn bg-learn px-3.5 py-2 text-[0.8125rem] font-medium text-[#140b2e] transition-colors hover:bg-learn/90"
            >
              <Play className="size-4" /> Set up this machine
            </button>
          ) : (
            <button
              onClick={() => onNavigate("labs")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-learn bg-learn px-3.5 py-2 text-[0.8125rem] font-medium text-[#140b2e] transition-colors hover:bg-learn/90"
            >
              Browse labs <ArrowRight className="size-4" />
            </button>
          )}
        </div>
      </div>

      {capacity && capacity.level === "low" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <TriangleAlert className="size-4 shrink-0 text-rose-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[0.8125rem] font-medium">
              {capacity.title} <span className="ml-1 font-mono text-[0.6875rem] text-muted-foreground">{capacity.totalGB.toFixed(1)} GB</span>
            </p>
            <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{capacity.detail}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => onNavigate("cloud")}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[0.75rem] text-foreground transition-colors hover:border-ring/60"
            >
              <Cloud className="size-3.5" /> Cloud
            </button>
            <button
              onClick={() => onNavigate("server")}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[0.75rem] text-foreground transition-colors hover:border-ring/60"
            >
              <Server className="size-3.5" /> Server
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[18.75rem_minmax(0,1fr)]">
        {/* LEFT RAIL */}
        <div className="space-y-5">
          <div>
            <RailLabel
              right={
                <button onClick={() => onNavigate("machine")} className="text-[0.71875rem] text-muted-foreground hover:text-foreground">
                  Open
                </button>
              }
            >
              This machine
            </RailLabel>
            <Panel>
              <MetricRow icon={Cpu} label="CPU" pct={metrics ? metrics.cpu : null} detail={metrics ? `${Math.round(metrics.cpu)}%` : "…"} />
              <MetricRow icon={MemoryStick} label="Memory" pct={memPct} detail={metrics ? `${gb(metrics.memUsed)} / ${gb(metrics.memTotal)} GB` : "…"} />
              <StatusRow
                name="Docker engine"
                value={report ? (report.dockerRunning ? "Running" : "Stopped") : "…"}
                tone={report?.dockerRunning ? "ok" : "warn"}
              />
              <StatusRow name="Containers" value={metrics ? `${metrics.containers}` : dockerReady ? "0" : "—"} tone="mut" />
            </Panel>
          </div>

          <div>
            <RailLabel
              right={
                running.length + (hostedActive ? 1 : 0) > 0 ? (
                  <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-emerald-500">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    {running.length + (hostedActive ? 1 : 0)}
                  </span>
                ) : undefined
              }
            >
              Running now
            </RailLabel>
            <Panel>
              {hostedActive && (
                <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-md border",
                      hostedRunning ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-500" : "border-learn/25 bg-learn/10 text-learn",
                    )}
                  >
                    <Globe className="size-3.5" />
                  </span>
                  <button onClick={() => hostedLab && onNavigate("labs", hostedLab.slug)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-[0.78125rem] font-medium hover:text-learn">{hostedLab?.title ?? "Hosted lab"}</p>
                    <p className="flex items-center gap-1 truncate text-[0.65625rem] text-muted-foreground">
                      {hostedRunning ? (
                        "Hosted by Cyber CTF"
                      ) : (
                        <>
                          <Spinner className="size-2.5" /> Starting on Cyber CTF…
                        </>
                      )}
                    </p>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {hostedRunning && hosted.session?.endpoints[0] && (
                      <button
                        onClick={() => openUrl(hosted.session!.endpoints[0].url).catch(() => {})}
                        className="rounded-md border border-learn bg-learn px-2 py-1 text-[0.6875rem] font-medium text-[#140b2e] hover:bg-learn/90"
                      >
                        Open
                      </button>
                    )}
                    <button
                      onClick={() => void hosted.stop()}
                      className="rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] text-foreground hover:border-ring/60"
                    >
                      Stop
                    </button>
                  </div>
                </div>
              )}
              {running.length === 0 && !hostedActive ? (
                <p className="px-3.5 py-4 text-[0.78125rem] text-muted-foreground">Nothing running yet. Start a lab to see it here.</p>
              ) : (
                running.map((lab) => {
                  const url = statuses[lab.id]?.url;
                  return (
                    <div key={lab.id} className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-emerald-500/25 bg-emerald-500/10 text-emerald-500">
                        <Container className="size-3.5" />
                      </span>
                      <button onClick={() => onNavigate("labs", lab.slug)} className="min-w-0 flex-1 text-left">
                        <p className="truncate text-[0.78125rem] font-medium hover:text-learn">{lab.title}</p>
                        {url && <p className="truncate font-mono text-[0.65625rem] text-muted-foreground">{url.replace("http://", "")}</p>}
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {url && (
                          <button
                            onClick={() => openUrl(url).catch(() => {})}
                            className="rounded-md border border-learn bg-learn px-2 py-1 text-[0.6875rem] font-medium text-[#140b2e] hover:bg-learn/90"
                          >
                            Open
                          </button>
                        )}
                        <button
                          onClick={() => stop(lab)}
                          disabled={busy === lab.id}
                          className="rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] text-foreground hover:border-ring/60 disabled:opacity-40"
                        >
                          {busy === lab.id ? "…" : "Stop"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </Panel>
          </div>
        </div>

        {/* RIGHT */}
        <div className="space-y-5">
          {recent.length > 0 && (
            <div>
              <RailLabel>Jump back in</RailLabel>
              <Panel>
                {recent.map(({ lab, ts }) => (
                  <div key={lab.id} className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
                      <RotateCcw className="size-3.5" />
                    </span>
                    <button onClick={() => onNavigate("labs", lab.slug)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-[0.78125rem] font-medium hover:text-learn">{lab.title}</p>
                      <p className="text-[0.65625rem] text-muted-foreground">last run {formatAgo(ts, now)}</p>
                    </button>
                    <button
                      onClick={() => launch(lab)}
                      disabled={busy === lab.id || !(auth?.loggedIn ?? false) || !lab.runtime}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-learn bg-learn px-2 py-1 text-[0.6875rem] font-medium text-[#140b2e] hover:bg-learn/90 disabled:opacity-40"
                    >
                      {busy === lab.id ? (
                        "…"
                      ) : (
                        <>
                          <Play className="size-3" /> Resume
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </Panel>
            </div>
          )}

          <div>
            <RailLabel
              right={
                <button
                  onClick={() => onNavigate("labs")}
                  className="inline-flex items-center gap-1 text-[0.71875rem] text-muted-foreground hover:text-foreground"
                >
                  All labs <ArrowRight className="size-3.5" />
                </button>
              }
            >
              Labs {labs && <span className="font-normal text-muted-foreground">{labs.length}</span>}
            </RailLabel>
            <Panel>
              {!labs ? (
                <p className="px-4 py-6 text-[0.78125rem] text-muted-foreground">Loading labs…</p>
              ) : labs.length === 0 ? (
                <p className="px-4 py-6 text-[0.78125rem] text-muted-foreground">No labs published yet.</p>
              ) : (
                preview.map((lab: Lab) => (
                  <LabRow
                    key={lab.id}
                    lab={lab}
                    status={statuses[lab.id]}
                    busy={busy === lab.id}
                    loggedIn={auth?.loggedIn ?? false}
                    hostArch={report?.arch ?? ""}
                    onOpen={() => onNavigate("labs", lab.slug)}
                    onStop={() => stop(lab)}
                  />
                ))
              )}
            </Panel>
          </div>

          {!auth?.loggedIn && (
            <p className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
              <ExternalLink className="size-3.5" /> Sign in (bottom-left) so labs launched from the website run here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
