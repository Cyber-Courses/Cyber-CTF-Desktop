"use client";

import { Crosshair, Play, Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogConsole } from "@/components/ui/log-console";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import type { AttackBox } from "@/features/labs/use-attack-box";
import { getAttackImage } from "@/lib/settings";

/** The attack box card in the lab page's side rail. `host` is the server a remote lab runs on. */
export function AttackBoxPanel({
  box,
  running,
  host,
  onShell,
  shellReady,
}: {
  box: AttackBox;
  running: boolean;
  host: string | null;
  onShell?: () => void;
  shellReady?: boolean;
}) {
  const remote = host !== null;
  const { status, busy, log } = box;
  return (
    <Panel>
      <PanelHeader
        title="Attack box"
        action={
          <span className="inline-block max-w-[9.5rem] truncate align-bottom font-mono text-[0.6875rem] text-muted-foreground" title={getAttackImage()}>
            {getAttackImage()}
          </span>
        }
      />
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-[0.8125rem]">
          <Crosshair className="size-4 text-learn" />
          {remote && running ? (
            <span>Running on {host}</span>
          ) : status?.running ? (
            <span className="flex items-center gap-1.5">
              Running <span className="font-mono text-[0.6875rem] text-muted-foreground">{status.ip}</span>
            </span>
          ) : busy ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Spinner className="size-3.5" /> Starting…
            </span>
          ) : (
            <span className="text-muted-foreground">{running ? "Not started" : "Starts with the lab"}</span>
          )}
        </div>
        <p className="text-[0.71875rem] text-muted-foreground">
          {remote
            ? "Your machine on the lab network. Open its shell to attack the targets; it connects over SSH."
            : "Your machine on the lab network. Open its shell to attack the targets from inside the lab."}
        </p>
        {onShell && shellReady && (
          <Button variant="learn" className="w-full" onClick={onShell}>
            <Terminal className="size-4" /> Open attacker shell
          </Button>
        )}
        {!remote && status && !status.imagePresent && !status.running && (
          <p className="text-[0.71875rem] text-amber-500">
            The first start downloads <span className="font-mono">{getAttackImage()}</span> (several GB).
          </p>
        )}
        {running && !remote && (
          <div className="space-y-2">
            {status?.running ? (
              <Button variant="outline" className="w-full" onClick={() => box.stop()} disabled={busy}>
                <Square className="size-3.5" /> {busy ? "Working…" : "Stop attack box"}
              </Button>
            ) : (
              <Button variant="outline" className="w-full" onClick={() => box.start()} disabled={busy}>
                {busy ? <Spinner className="size-4" /> : <Play className="size-4" />} Start attack box
              </Button>
            )}
          </div>
        )}
        {(busy || log.some((l) => l.startsWith("✗"))) && log.length > 0 && <LogConsole lines={log} running={busy} title="Attack box" />}
      </div>
    </Panel>
  );
}
