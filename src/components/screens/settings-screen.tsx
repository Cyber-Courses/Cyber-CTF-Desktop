"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { agentInfo, type AgentInfo, type AuthStatus } from "@/lib/tauri";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

export function SettingsScreen({ auth }: { auth: AuthStatus | null }) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);

  useEffect(() => {
    agentInfo().then(setAgent).catch(() => setAgent(null));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your account and this launcher.</p>
      </div>

      <Card className="p-5">
        <p className="mb-3 text-sm font-medium">Account</p>
        <Field label="Signed in" value={auth?.loggedIn ? "yes" : "no"} />
        {auth?.name && <Field label="Name" value={auth.name} />}
        {auth?.email && <Field label="Email" value={auth.email} />}
      </Card>

      <Card className="p-5">
        <p className="mb-1 text-sm font-medium">This machine</p>
        <p className="mb-3 text-xs text-muted-foreground">Registered as a launcher so you can run labs on it from the website, from any device.</p>
        {agent ? (
          <>
            <Field label="Name" value={agent.name} />
            <Field label="Architecture" value={agent.arch} />
            <Field label="Runs" value={agent.capabilities.join(", ") || "—"} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Sign in to register this machine.</p>
        )}
      </Card>
    </div>
  );
}
