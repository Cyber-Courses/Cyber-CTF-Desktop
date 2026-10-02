"use client";

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { useLabs, type Lab } from "@/lib/use-labs";
import { labStop, type AuthStatus, type SystemReport } from "@/lib/tauri";

type Tab = "labs" | "machine" | "settings";

function Stat({ value, label, hint, tone }: { value: string | number; label: string; hint?: string; tone?: "ok" | "warn" }) {
  return (
    <Card className="p-5">
      <p className={`text-3xl font-semibold tracking-tight tabular-nums ${tone === "ok" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : "text-foreground"}`}>{value}</p>
      <p className="mt-1 text-sm text-foreground">{label}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
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
        <Stat value={error ? "—" : (labs?.length ?? "…")} label="Labs available" hint={error ? "Backend unreachable" : "Across every technique"} />
        <Stat value={dockerReady ? "Ready" : "Not ready"} label="Containers" hint={dockerReady ? "Container labs can run" : "Set it up in This machine"} tone={dockerReady ? "ok" : "warn"} />
        <Stat value={hypervisors} label={hypervisors === 1 ? "Hypervisor ready" : "Hypervisors ready"} hint="For VM labs" />
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
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{url ?? "Running on this machine"}</p>
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
