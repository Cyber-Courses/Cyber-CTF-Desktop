"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Cpu, FlaskConical, MemoryStick, MoreHorizontal, Pencil, Star, Trash2, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { KIND } from "@/features/servers/host-setup";
import { type HostCapacity, type ServerHost, type ServerTest } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { ServerSelfTest } from "@/features/servers/server-self-test";
import { StatusPill, type Tone } from "@/components/ui/status-pill";
import { ProviderGlyph } from "@/features/servers/provider-glyph";
import { formatAgo, formatBytes } from "@/lib/format";
import { VmTest } from "@/features/servers/vm-tests";

export function HostRow({
  host,
  isDefault,
  running,
  capacity,
  test,
  lastVm,
  now,
  vmTesting,
  onTest,
  onVmTest,
  onVmTestDone,
  onEdit,
  onDefault,
  onRemove,
}: {
  host: ServerHost;
  isDefault: boolean;
  running: number;
  capacity: HostCapacity | null | undefined;
  test: ServerTest | "testing" | undefined;
  lastVm: VmTest | undefined;
  now: number;
  vmTesting: boolean;
  onTest: () => void;
  onVmTest: () => void;
  onVmTestDone: (result: "ok" | "fail") => void;
  onEdit: () => void;
  onDefault: () => void;
  onRemove: () => void;
}) {
  const result = test && test !== "testing" ? test : null;
  const tone: Tone = test === "testing" || !test ? "muted" : result!.ok ? "ok" : "fail";
  const status = test === "testing" ? "Testing…" : !test ? "Not tested" : result!.ok ? "Online" : "Unreachable";
  const endpoint = `${KIND[host.provider].label} · ${host.username}@${host.host}:${host.port}${host.node ? ` · node ${host.node}` : ""}`;
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <ProviderGlyph provider={host.provider} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem] font-medium">
            {host.name}
            <StatusPill tone={tone}>
              {status}
              {result?.latencyMs != null && <span className="ml-1 font-mono text-[0.65625rem] tabular-nums text-muted-foreground">{result.latencyMs} ms</span>}
            </StatusPill>
            <button
              type="button"
              onClick={onDefault}
              title={isDefault ? "The default host for website launches. Click to unset." : "Make this the default host for website launches."}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.59375rem] font-medium uppercase tracking-wide transition-colors",
                isDefault ? "border-learn/50 bg-learn/10 text-learn" : "border-border text-muted-foreground/70 hover:border-ring/60 hover:text-foreground",
              )}
            >
              <Star className={cn("size-2.5", isDefault && "fill-current")} /> Default
            </button>
          </p>
          <p className="mt-0.5 truncate font-mono text-[0.71875rem] text-muted-foreground">{endpoint}</p>
          {/* Capacity, running labs and the last VM test: only the ones we actually know. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
            {capacity && (
              <>
                <span className="inline-flex items-center gap-1">
                  <Cpu className="size-3" /> {capacity.cores} vCPU
                </span>
                <span className="inline-flex items-center gap-1">
                  <MemoryStick className="size-3" /> {formatBytes(capacity.memFree)} free of {formatBytes(capacity.memTotal)}
                </span>
              </>
            )}
            {running > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-learn">
                <span className="size-1.5 rounded-full bg-learn" /> {running} lab{running > 1 ? "s" : ""} running
              </span>
            )}
            {lastVm && (
              <span className={cn("inline-flex items-center gap-1", lastVm.result === "ok" ? "text-emerald-500" : "text-rose-500")}>
                {lastVm.result === "ok" ? <Check className="size-3" /> : <X className="size-3" />} VM test {lastVm.result === "ok" ? "passed" : "failed"} ·{" "}
                {formatAgo(lastVm.at, now)}
              </span>
            )}
          </p>
          {result && !result.ok && <p className="mt-1 text-[0.75rem] text-rose-500">{result.message}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onTest} disabled={test === "testing"}>
            {test === "testing" ? <Spinner className="size-3.5" /> : <Zap className="size-3.5" />} Test
          </Button>
          <Menu
            items={[
              { label: vmTesting ? "Hide VM test" : "VM test", icon: FlaskConical, onClick: onVmTest },
              { label: "Edit", icon: Pencil, onClick: onEdit },
              { label: "Remove", icon: Trash2, danger: true, onClick: onRemove },
            ]}
          />
        </div>
      </div>
      {vmTesting && (
        <div className="px-3.5 pb-3.5">
          <ServerSelfTest id={host.id} provider={host.provider} onDone={onVmTestDone} />
        </div>
      )}
    </div>
  );
}

type MenuItem = { label: string; icon: typeof Pencil; onClick: () => void; danger?: boolean };
/** Overflow menu. The dropdown is positioned `fixed` from the trigger's rect so it escapes
 *  the Panel's `overflow-hidden` (an `absolute` child would be clipped). It closes on scroll
 *  or resize, since a fixed position would otherwise drift from the button. */
function Menu({ items }: { items: MenuItem[] }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="More actions"
        onClick={() => (pos ? setPos(null) : open())}
        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {pos && (
        <>
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setPos(null)} />
          <div
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            className="z-50 w-36 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={() => {
                  setPos(null);
                  it.onClick();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.78125rem] transition-colors hover:bg-muted",
                  it.danger ? "text-rose-500" : "text-foreground",
                )}
              >
                <it.icon className="size-3.5" /> {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
