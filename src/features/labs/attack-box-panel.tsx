"use client";

import { Crosshair, Play, Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogConsole } from "@/components/ui/log-console";
import { CopyValue } from "@/components/ui/copy-value";
import { KeyValue, Panel, PanelHeader } from "@/components/ui/panel";
import { StatusDot } from "@/components/ui/status-pill";
import { Spinner } from "@/components/ui/spinner";
import type { AttackBox } from "@/features/labs/use-attack-box";

/** The attack box card in the lab page's side rail. `host` is the server a remote lab runs on.
 *  `controller`: the lab runs on QEMU, whose network links only its two VMs, so the lab's own
 *  controller is the attacker (no attack VM to start or stop). */
export function AttackBoxPanel({
  box,
  running,
  host,
  onShell,
  shellReady,
  controller = false,
}: {
  box: AttackBox;
  running: boolean;
  host: string | null;
  onShell?: () => void;
  shellReady?: boolean;
  controller?: boolean;
}) {
  const remote = host !== null;
  const { status, busy, log } = box;
  const name = controller ? "isoloom-controller" : box.name;
  const vm = box.kind === "vm";
  const tone = (remote && running) || status?.running ? "ok" : busy ? "warn" : "muted";
  return (
    <Panel>
      <PanelHeader
        title={
          <>
            <StatusDot tone={tone} pulse={busy} />
            {controller ? "Attacker" : vm ? "Attack VM" : "Attack box"}
          </>
        }
        action={
          <span className="inline-block max-w-[9.5rem] truncate align-bottom font-mono text-[0.6875rem] text-faint" title={name}>
            {name}
          </span>
        }
      />
      <KeyValue k="Status">
        {remote && running ? (
          <>running on {host}</>
        ) : status?.running ? (
          <span className="inline-flex items-center gap-1.5">
            <Crosshair className="size-3.5 text-you-text" /> running
          </span>
        ) : busy ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Spinner className="size-3" /> starting
          </span>
        ) : (
          <span className="text-muted-foreground">{running ? "not started" : "starts with the lab"}</span>
        )}
      </KeyValue>
      {status?.running && status.ip && (
        <KeyValue k="Address">
          <CopyValue text={status.ip} />
        </KeyValue>
      )}
      <div className="space-y-3 border-t border-border p-4">
        <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
          {remote
            ? "Your machine on the lab network. Open its shell to attack the targets; it connects over SSH."
            : controller
              ? "On QEMU the lab network links only the lab's two VMs, so its controller (Debian, on the lab network, with the internet) is your attacker. Open its shell and install your tools with apt."
              : vm
                ? "Your own VM beside the lab, on every lab network, with the internet to install tools. Open its shell to attack the targets; it connects over SSH."
                : "Your machine on the lab network. Open its shell to attack the targets from inside the lab."}
        </p>
        {onShell && shellReady && (
          <Button variant="primary" size="sm" className="w-full" onClick={onShell}>
            <Terminal className="size-3.5" /> Open attacker shell
          </Button>
        )}
        {!remote && !controller && status && !status.imagePresent && !status.running && (
          <p className="flex items-start gap-2 text-[0.75rem] text-muted-foreground">
            <StatusDot tone="warn" className="mt-1.5 shrink-0" />
            <span>
              The first start downloads <span className="font-mono text-foreground">{name}</span> (several GB).
            </span>
          </p>
        )}
        {running && !remote && !controller && (
          <div className="space-y-2">
            {status?.running ? (
              <Button variant="outline" size="sm" className="w-full" onClick={() => box.stop()} disabled={busy}>
                <Square className="size-3.5" /> {busy ? "Working…" : "Stop attack box"}
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="w-full" onClick={() => box.start()} disabled={busy}>
                {busy ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />} Start attack box
              </Button>
            )}
          </div>
        )}
        {(busy || log.some((l) => l.startsWith("✗"))) && log.length > 0 && <LogConsole lines={log} running={busy} title={vm ? "Attack VM" : "Attack box"} />}
      </div>
    </Panel>
  );
}
