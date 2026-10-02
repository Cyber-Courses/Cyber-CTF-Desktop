"use client";

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { agentInfo, type AgentInfo, type AuthStatus } from "@/lib/tauri";

const ONBOARDED_KEY = "cyberctf.onboarded";

function Field({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-foreground" : "text-foreground"}>{value}</span>
    </div>
  );
}

export function SettingsScreen({ auth }: { auth: AuthStatus | null }) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [upd, setUpd] = useState<"idle" | "checking" | "none" | { version: string }>("idle");

  useEffect(() => {
    agentInfo().then(setAgent).catch(() => setAgent(null));
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  async function checkUpdates() {
    setUpd("checking");
    try {
      const u = await check();
      setUpd(u ? { version: u.version } : "none");
    } catch {
      setUpd("none");
    }
  }

  function replayOnboarding() {
    try {
      localStorage.removeItem(ONBOARDED_KEY);
    } catch {
      /* ignore */
    }
    location.reload();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your account and this launcher.</p>
      </div>

      <Card className="p-5">
        <p className="mb-3 text-sm font-medium">Account</p>
        <Field label="Signed in" value={auth?.loggedIn ? "yes" : "no"} mono={false} />
        {auth?.name && <Field label="Name" value={auth.name} mono={false} />}
        {auth?.email && <Field label="Email" value={auth.email} />}
      </Card>

      <Card className="p-5">
        <p className="mb-1 text-sm font-medium">This machine</p>
        <p className="mb-3 text-xs text-muted-foreground">Registered as a launcher so you can run labs on it from the website, from any device.</p>
        {agent ? (
          <>
            <Field label="Name" value={agent.name} mono={false} />
            <Field label="Architecture" value={agent.arch} />
            <Field label="Runs" value={agent.capabilities.join(", ") || "—"} mono={false} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Sign in to register this machine.</p>
        )}
      </Card>

      <Card className="p-5">
        <p className="mb-3 text-sm font-medium">About</p>
        <Field label="Version" value={version ? `v${version}` : "…"} />
        <div className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
          <span className="text-muted-foreground">
            {upd === "none" ? "You’re up to date" : typeof upd === "object" ? `Update available: v${upd.version}` : "Check for updates"}
          </span>
          <Button variant="outline" size="sm" onClick={checkUpdates} disabled={upd === "checking"}>
            {upd === "checking" ? (<><Spinner className="size-3.5" /> Checking…</>) : "Check now"}
          </Button>
        </div>
        {typeof upd === "object" && (
          <p className="pt-2 text-xs text-muted-foreground">The update will be offered from the banner at the top of the app.</p>
        )}
      </Card>

      <Card className="flex items-center justify-between gap-4 p-5">
        <div>
          <p className="text-sm font-medium">Replay onboarding</p>
          <p className="mt-1 text-sm text-muted-foreground">Walk through the first-run setup again.</p>
        </div>
        <Button variant="outline" size="sm" onClick={replayOnboarding} className="shrink-0">Replay</Button>
      </Card>
    </div>
  );
}
