"use client";

import { LogOut } from "lucide-react";
import { initials, useAuthActions } from "@/features/account/account";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type AgentInfo, type AuthStatus } from "@/lib/tauri";
import { Row, Section } from "@/features/settings/settings-layout";

/* ------------------------------------------------------------------ account */

export function AccountSection({ auth, agent, onAuthChange }: { auth: AuthStatus | null; agent: AgentInfo | null; onAuthChange: (s: AuthStatus) => void }) {
  const { login, logout, busy, error } = useAuthActions(onAuthChange);

  return (
    <Section title="Account" description="Signing in registers this machine, so labs you launch from the website run here.">
      {auth === null ? (
        <Row
          title={
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Checking…
            </span>
          }
        />
      ) : auth.loggedIn ? (
        <>
          <div className="flex items-center gap-3.5 px-5 py-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-learn/15 text-sm font-semibold text-learn">
              {initials(auth.name, auth.email)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{auth.name ?? "Signed in"}</p>
              {auth.email && <p className="truncate text-[0.8125rem] text-muted-foreground">{auth.email}</p>}
            </div>
            <Button variant="outline" size="sm" onClick={logout}>
              <LogOut className="size-3.5" /> Sign out
            </Button>
          </div>
          <Row
            title={
              <span className="flex items-center gap-2">
                This machine
                <Badge variant="success" dot>
                  Online
                </Badge>
              </span>
            }
            description={
              agent ? (
                <>
                  {agent.name} <span className="text-muted-foreground/60">·</span> <span className="font-mono text-xs">{agent.arch}</span>
                  {agent.capabilities.length > 0 && (
                    <>
                      {" "}
                      <span className="text-muted-foreground/60">·</span> runs {agent.capabilities.join(", ")}
                    </>
                  )}
                </>
              ) : (
                "Registering…"
              )
            }
          />
        </>
      ) : (
        <Row
          title={
            <span className="flex items-center gap-2">
              Not signed in
              <Badge variant="outline">Offline</Badge>
            </span>
          }
          description={
            (error ?? auth.keychainError) ? (
              <span className="text-destructive">{error ?? auth.keychainError}</span>
            ) : (
              "Sign in with your Cyber account to sync labs and run them from any device."
            )
          }
          control={
            <Button variant="learn" size="sm" onClick={login} disabled={busy}>
              {busy ? (
                <>
                  <Spinner className="size-3.5" /> Waiting for the browser…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          }
        />
      )}
    </Section>
  );
}
