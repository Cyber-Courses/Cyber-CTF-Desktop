"use client";

import { useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { useLabs, type Lab } from "@/lib/use-labs";
import { labStop, type AuthStatus, type SystemReport } from "@/lib/tauri";

type Tab = "labs" | "machine" | "settings";

function Stat({ icon, label, value, hint }: { icon: IconName; label: string; value: ReactNode; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <Icon name={icon} className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function DotValue({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`size-2 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
      {children}
    </span>
  );
}

export function HomeScreen({
  report,
  auth,
  onNavigate,
}: {
  report: SystemReport | null;
  auth: AuthStatus | null;
  onNavigate: (tab: Tab) => void;
}) {
  const { labs, error, statuses, refreshStatus } = useLabs(auth?.loggedIn ?? false);
  const [stopping, setStopping] = useState<string | null>(null);

  const dockerReady = report ? report.docker.installed && report.dockerRunning : false;
  const hypervisors = report ? report.vmProviders.filter((p) => !p.remote && p.hypervisor === true).length : 0;
  const running = (labs ?? []).filter((l) => statuses[l.id]?.running);
  const greeting = auth?.loggedIn ? `Welcome back${auth.name ? `, ${auth.name}` : ""}.` : "Welcome to Cyber CTF.";

  async function stop(lab: Lab) {
    if (!lab.runtime) return;
    setStopping(lab.id);
    try {
      await labStop(lab.id, lab.runtime.runtime, () => {});
    } finally {
      setStopping(null);
      refreshStatus(lab);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">{greeting} Run realistic labs on your own machine.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon="labs" label="Labs" value={error ? "—" : (labs?.length ?? "…")} hint={error ? "Backend unreachable" : "Available to run"} />
        <Stat icon="container" label="Containers" value={<DotValue ok={dockerReady}>{dockerReady ? "Ready" : "Not ready"}</DotValue>} hint={dockerReady ? "Container labs can run" : "Set up in Machine"} />
        <Stat icon="cpu" label="Hypervisors" value={hypervisors} hint={hypervisors ? "Ready for VM labs" : "None installed"} />
      </div>

      {running.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight">Running now</h2>
            <Badge variant="success" dot>{running.length}</Badge>
          </div>
          <div className="space-y-2.5">
            {running.map((lab) => {
              const url = statuses[lab.id]?.url;
              return (
                <Card key={lab.id} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{lab.title}</p>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{url ?? "Running on this machine"}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {url && (
                      <Button variant="learn" size="sm" onClick={() => openUrl(url).catch(() => {})}>
                        <Icon name="external" className="size-3.5" /> Open
                      </Button>
                    )}
                    <Button variant="destructive" size="sm" onClick={() => stop(lab)} disabled={stopping === lab.id}>
                      {stopping === lab.id ? "Stopping…" : "Stop"}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">{auth?.loggedIn ? "Pick a lab and run it on this machine" : "Sign in to run labs on this machine"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {auth?.loggedIn
              ? "Browse the catalogue, or launch a lab from the website and it runs here."
              : "Log in with your Cyber CTF account to register this machine and launch labs."}
          </p>
        </div>
        <Button variant="learn" onClick={() => onNavigate("labs")} className="shrink-0">
          Browse labs <Icon name="arrowRight" className="size-4" />
        </Button>
      </Card>

      {!dockerReady && (
        <Card className="flex items-center justify-between gap-4 p-5">
          <div>
            <p className="text-sm font-medium">Finish setting up this machine</p>
            <p className="mt-1 text-sm text-muted-foreground">Install Docker (and optionally a hypervisor) so labs can run locally.</p>
          </div>
          <Button variant="outline" onClick={() => onNavigate("machine")} className="shrink-0">Set up</Button>
        </Card>
      )}
    </div>
  );
}
