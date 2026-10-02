"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiQuery, type AuthStatus, type SystemReport } from "@/lib/tauri";

type Tab = "labs" | "machine" | "settings";

function Stat({ value, label, hint }: { value: string | number; label: string; hint?: string }) {
  return (
    <Card className="p-5">
      <p className="text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
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
  const [labCount, setLabCount] = useState<number | null>(null);
  const [apiError, setApiError] = useState(false);

  useEffect(() => {
    apiQuery<{ labs: { id: string }[] }>("{ labs { id } }")
      .then((d) => {
        setLabCount(d.labs.length);
        setApiError(false);
      })
      .catch(() => setApiError(true));
  }, []);

  const dockerReady = report ? report.docker.installed && report.dockerRunning : false;
  const hypervisors = report ? report.vmProviders.filter((p) => !p.remote && p.hypervisor === true).length : 0;
  const greeting = auth?.loggedIn ? `Welcome back${auth.name ? `, ${auth.name}` : ""}.` : "Welcome to Cyber CTF.";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">{greeting} Run realistic labs on your own machine.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat value={apiError ? "—" : labCount ?? "…"} label="Labs available" hint={apiError ? "Backend unreachable" : "Across every technique"} />
        <Stat value={dockerReady ? "Ready" : "Not ready"} label="Containers" hint={dockerReady ? "Container labs can run" : "Set it up in This machine"} />
        <Stat value={hypervisors} label={hypervisors === 1 ? "Hypervisor ready" : "Hypervisors ready"} hint="For VM labs" />
      </div>

      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">{auth?.loggedIn ? "Pick a lab and run it on this machine" : "Sign in to run labs on this machine"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {auth?.loggedIn
              ? "Browse the catalogue, or launch a lab from the website and it runs here."
              : "Log in with your Cyber CTF account to register this machine and launch labs."}
          </p>
        </div>
        <Button variant="learn" onClick={() => onNavigate("labs")} className="shrink-0">Browse labs</Button>
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
