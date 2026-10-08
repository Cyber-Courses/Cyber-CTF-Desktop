"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FlaskConical, MoreHorizontal, Pencil, Star, Trash2, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { KIND } from "@/features/servers/host-setup";
import { type HostCapacity, type ServerHost, type ServerTest } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { ServerSelfTest } from "@/features/servers/server-self-test";
import { StatusDot, StatusPill, type Tone } from "@/components/ui/status-pill";
import { ProviderGlyph } from "@/features/servers/provider-glyph";
import { formatAgo, formatBytes } from "@/lib/format";
import { VmTest } from "@/features/servers/vm-tests";
import { openExternal } from "@/lib/failure";

/** A host on a private LAN address: what macOS's Local Network permission governs. */
const isPrivateHost = (h: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith(".local");
const onMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const LOCAL_NETWORK_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork";

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
  // A missing password is a credential to enter, not a host that is down.
  const needsPassword = !!result && !result.ok && /no password stored/i.test(result.message);
  const tone: Tone = test === "testing" || !test ? "muted" : result!.ok ? "ok" : needsPassword ? "warn" : "fail";
  const status = test === "testing" ? "Testing…" : !test ? "Not tested" : result!.ok ? "Online" : needsPassword ? "Needs password" : "Unreachable";
  // The running-labs count is filesystem-only and can go stale when a host drops. Only trust it
  // once the host answers as Online; an unreachable host must not report a phantom count.
  const online = !!result && result.ok;
  const facts = [
    KIND[host.provider].label,
    `${host.username}@${host.host}:${host.port}`,
    host.node ? `node ${host.node}` : null,
    capacity ? `${capacity.cores} vCPU` : null,
    capacity ? `${formatBytes(capacity.memFree)} free of ${formatBytes(capacity.memTotal)}` : null,
  ].filter(Boolean);
  const showExtras = (online && running > 0) || !!lastVm || (!!result && !result.ok);
  return (
    <div className="border-t border-border first:border-t-0">
      <div className="grid min-h-[3.25rem] grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3.5 px-4 py-2.5 transition-colors hover:bg-glass">
        <ProviderGlyph provider={host.provider} />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] font-medium text-foreground">
            <span className="truncate">{host.name}</span>
            <button
              type="button"
              onClick={onDefault}
              title={isDefault ? "The default host for website launches. Click to unset." : "Make this the default host for website launches."}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-px font-mono text-[0.625rem] font-medium transition-colors",
                isDefault
                  ? "text-jewel-text shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--jewel)_40%,transparent)]"
                  : "text-faint shadow-[inset_0_0_0_1px_var(--border)] hover:text-foreground hover:shadow-[inset_0_0_0_1px_var(--input)]",
              )}
            >
              <Star className={cn("size-2.5", isDefault && "fill-current")} /> default
            </button>
          </p>
          <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-faint">{facts.join(" · ")}</p>
          {/* Running labs, the last VM test and a failure: only the ones we actually know. */}
          {showExtras && (
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.75rem] text-muted-foreground">
              {online && running > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone="ok" /> {running} lab{running > 1 ? "s" : ""} running
                </span>
              )}
              {lastVm && (
                <span className="inline-flex items-center gap-1">
                  {lastVm.result === "ok" ? <Check className="size-3 text-success" /> : <X className="size-3 text-destructive" />} VM test{" "}
                  {lastVm.result === "ok" ? "passed" : "failed"} <span className="font-mono text-[0.6875rem] text-faint">{formatAgo(lastVm.at, now)}</span>
                </span>
              )}
              {result && !result.ok && (
                <span className="inline-flex min-w-0 items-start gap-1.5">
                  <StatusDot tone={needsPassword ? "warn" : "fail"} className="mt-1.5" />
                  <span className="min-w-0 break-words">{result.message}</span>
                </span>
              )}
            </p>
          )}
          {/* A denied Local Network permission looks exactly like a host that is down. */}
          {result && !result.ok && !needsPassword && onMac() && isPrivateHost(host.host) && (
            <p className="mt-1 text-[0.75rem] text-muted-foreground">
              If the host is up, macOS may be blocking Cyber CTF from your local network: turn Cyber CTF on under Privacy &amp; Security &gt; Local Network.{" "}
              <button type="button" className="text-link underline underline-offset-2" onClick={() => openExternal(LOCAL_NETWORK_SETTINGS)}>
                Open Privacy &amp; Security
              </button>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill tone={tone} pulse={test === "testing"}>
            {status}
            {result?.latencyMs != null && <span className="font-mono text-[0.6875rem] font-normal tabular-nums text-faint">{result.latencyMs} ms</span>}
          </StatusPill>
          <Button variant="outline" size="xs" onClick={onTest} disabled={test === "testing"}>
            {test === "testing" ? <Spinner className="size-3" /> : <Zap className="size-3" />} Test
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
        <div className="px-4 pb-3.5">
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
        className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-glass-2 hover:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {pos && (
        <>
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setPos(null)} />
          <div style={{ position: "fixed", top: pos.top, right: pos.right }} className="surface-glass z-50 w-36 overflow-hidden rounded-control p-1">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={() => {
                  setPos(null);
                  it.onClick();
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors hover:bg-glass-2",
                  it.danger ? "text-destructive" : "text-foreground",
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
