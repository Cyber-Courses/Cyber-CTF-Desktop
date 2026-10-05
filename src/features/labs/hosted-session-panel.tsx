"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ExternalLink, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import type { HostedSession } from "@/features/hosted/use-hosted-labs";

const STAGE: Record<string, string> = {
  REQUESTED: "Asking Cyber CTF for an instance",
  CLAIMED: "Preparing your instance",
  PULLING: "Starting the lab",
};

function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  return `Expires in ${h > 0 ? `${h}h ` : ""}${mins % 60}m.`;
}

/** A lab running hosted by Cyber CTF, on its lab page: starting, running (open its URLs), or failed. */
export function HostedSessionPanel({
  session,
  starting,
  error,
  onStop,
}: {
  session: HostedSession | null;
  starting: boolean;
  error: string | null;
  onStop: () => void;
}) {
  const state = session?.state;
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          {state === "RUNNING" ? (
            <>
              <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-emerald-500">
                <CheckCircle2 className="size-3.5" /> Running, hosted by Cyber CTF
              </p>
              <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                Open it in your browser and attack it with your own tools. {expiresIn(session!.expiresAt)}
              </p>
            </>
          ) : state === "FAILED" || error ? (
            <>
              <p className="text-[0.8125rem] font-medium text-destructive">
                {state === "FAILED" ? "Couldn’t start the hosted lab" : "This is taking longer than expected"}
              </p>
              <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{error ?? session?.message ?? "Try again in a moment."}</p>
            </>
          ) : state === "STOPPED" || state === "EXPIRED" ? (
            <p className="text-[0.8125rem] text-muted-foreground">The hosted session {state === "EXPIRED" ? "expired" : "ended"}.</p>
          ) : (
            <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
              <Spinner className="size-4" /> {(state && STAGE[state]) ?? (starting ? "Asking Cyber CTF for an instance" : "Starting")}… This usually takes about
              30 seconds.
            </p>
          )}
        </div>
        {(session || error) && (
          <div className="flex flex-wrap items-center gap-2">
            {session &&
              state === "RUNNING" &&
              session.endpoints.map((e) => (
                <Button key={e.port} variant="learn" size="sm" onClick={() => openUrl(e.url).catch(() => {})}>
                  Open{session.endpoints.length > 1 ? ` :${e.port}` : ""} <ExternalLink className="size-3.5" />
                </Button>
              ))}
            <Button variant="outline" size="sm" onClick={onStop}>
              {!session || state === "FAILED" || state === "STOPPED" || state === "EXPIRED" ? (
                "Dismiss"
              ) : (
                <>
                  <Square className="size-3.5" /> Stop
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
