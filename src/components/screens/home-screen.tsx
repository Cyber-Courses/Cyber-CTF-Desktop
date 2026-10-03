"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Container } from "lucide-react";
import { Panel, RailLabel } from "@/components/ui/panel";
import { LabRow } from "@/components/labs/lab-row";
import { useLabs, type Lab } from "@/lib/use-labs";
import { useLabActions } from "@/lib/use-lab-actions";
import { cn } from "@/lib/utils";
import type { AuthStatus, SystemReport } from "@/lib/tauri";

type Tab = "labs" | "machine" | "settings";

function StatusRow({ name, value, tone }: { name: string; value: string; tone?: "ok" | "warn" | "mut" }) {
  return (
    <div className="flex items-center border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <span className="text-muted-foreground">{name}</span>
      <span className={cn("ml-auto flex items-center gap-1.5", tone === "ok" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : "text-foreground")}>
        {(tone === "ok" || tone === "warn") && <span className={cn("size-1.5 rounded-full", tone === "ok" ? "bg-emerald-500" : "bg-amber-500")} />}
        {value}
      </span>
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

  const dockerReady = report ? report.docker.installed && report.dockerRunning : false;
  const hypervisors = report ? report.vmProviders.filter((p) => !p.remote && p.hypervisor === true).length : 0;
  const running = (labs ?? []).filter((l) => statuses[l.id]?.running);
  const preview = (labs ?? []).slice(0, 6);

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* LEFT RAIL */}
      <div className="space-y-5">
        <div>
          <RailLabel right={<button onClick={() => onNavigate("machine")} className="text-[11.5px] text-muted-foreground hover:text-foreground">Set up</button>}>
            This machine
          </RailLabel>
          <Panel>
            <StatusRow name="Docker engine" value={report ? (report.dockerRunning ? "Running" : "Stopped") : "…"} tone={report?.dockerRunning ? "ok" : "warn"} />
            <StatusRow name="Containers" value={dockerReady ? "Ready" : "Not ready"} tone={dockerReady ? "ok" : "warn"} />
            <StatusRow name="Hypervisors" value={report ? `${hypervisors} ready` : "…"} tone="mut" />
            <StatusRow name="Architecture" value={report?.arch ?? "…"} tone="mut" />
          </Panel>
        </div>

        <div>
          <RailLabel right={running.length > 0 ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-500"><span className="size-1.5 rounded-full bg-emerald-500" />{running.length}</span> : undefined}>
            Running now
          </RailLabel>
          <Panel>
            {running.length === 0 ? (
              <p className="px-3.5 py-4 text-[12.5px] text-muted-foreground">Nothing running yet. Start a lab to see it here.</p>
            ) : (
              running.map((lab) => {
                const url = statuses[lab.id]?.url;
                return (
                  <div key={lab.id} className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-emerald-500/25 bg-emerald-500/10 text-emerald-500">
                      <Container className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium">{lab.title}</p>
                      {url && <p className="truncate font-mono text-[10.5px] text-muted-foreground">{url.replace("http://", "")}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {url && (
                        <button onClick={() => openUrl(url).catch(() => {})} className="rounded-md border border-learn bg-learn px-2 py-1 text-[11px] font-medium text-[#140b2e] hover:bg-learn/90">Open</button>
                      )}
                      <button onClick={() => stop(lab)} disabled={busy === lab.id} className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:border-ring/60 disabled:opacity-40">
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

      {/* RIGHT: LABS */}
      <div>
        <RailLabel right={<button onClick={() => onNavigate("labs")} className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">All labs <ArrowRight className="size-3.5" /></button>}>
          Labs {labs && <span className="font-normal text-muted-foreground">{labs.length}</span>}
        </RailLabel>
        <Panel>
          {!labs ? (
            <p className="px-4 py-6 text-[12.5px] text-muted-foreground">Loading labs…</p>
          ) : labs.length === 0 ? (
            <p className="px-4 py-6 text-[12.5px] text-muted-foreground">No labs published yet.</p>
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
                onStart={() => launch(lab)}
                onStop={() => stop(lab)}
              />
            ))
          )}
        </Panel>
      </div>
    </div>
  );
}
