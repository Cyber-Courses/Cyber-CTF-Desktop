"use client";

import { CheckCircle2, ChevronRight, Cloud, Container, ExternalLink, Globe, LogIn, Monitor, Server, Wrench, type LucideIcon } from "lucide-react";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/features/labs/use-labs";
import { CLOUDS } from "@/features/labs/run-on";
import { machineOpenSetup, type LabStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { openExternal, tell } from "@/lib/failure";

const SERVERS = new Set(["vmware_esxi", "proxmox"]);

/** Whether the lab is built for this CPU (no architectures listed = any). */
export const runsNatively = (rt: NonNullable<Lab["runtime"]>, hostArch: string) => !rt.architectures.length || rt.architectures.includes(hostArch);

type PlaceKey = NonNullable<LabStatus["place"]> | "hosted";

/** Every place a lab could run, and whether this one can (its runtime here, then its providers).
 *  A VM lab built for another CPU can't run on this machine's hypervisors (x86 Windows on Apple
 *  Silicon), so `hostArch` takes "VM on this machine" away; containers still run emulated. */
export function runPlaces(rt: NonNullable<Lab["runtime"]>, hostArch?: string): { key: PlaceKey; icon: LucideIcon; label: string; available: boolean }[] {
  // providers also carries "hosted" (not a launcher Provider), so compare as strings.
  const local = rt.providers.some((p: string) => !SERVERS.has(p) && !CLOUDS.has(p) && p !== "hosted");
  const vm = rt.runtime === "VM";
  return [
    { key: "container", icon: Container, label: "Container on this machine", available: !vm },
    { key: "local_vm", icon: Monitor, label: "VM on this machine", available: (vm || local) && !(vm && hostArch && !runsNatively(rt, hostArch)) },
    { key: "server", icon: Server, label: "Your server", available: rt.providers.some((p) => SERVERS.has(p)) },
    { key: "cloud", icon: Cloud, label: "Your cloud account", available: rt.providers.some((p) => CLOUDS.has(p)) },
    { key: "hosted", icon: Globe, label: "Hosted by Cyber CTF", available: rt.hosted ?? false },
  ];
}

/** A row action: compact, and it doesn't open the row when clicked. */
function RowButton({
  tone = "default",
  onClick,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { tone?: "default" | "learn" | "danger"; onClick: () => void }) {
  const variant = tone === "learn" ? "learn" : tone === "danger" ? "destructive" : "outline";
  return (
    <Button
      size="xs"
      variant={variant}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      {...props}
    />
  );
}

/**
 * One lab as a dense list row: runtime glyph, title + difficulty/category, the run-place icons
 * (where it runs / can run / can't), and Open + Stop while it runs, with a chevron into the
 * detail (starting happens on the lab's own page). Reused on the Overview rail-list and the full
 * Labs list.
 */
export function LabRow({
  lab,
  status,
  busy = false,
  loggedIn,
  onLogin,
  hostArch,
  onOpen,
  onStop,
  onResume,
  solved = false,
  setup = null,
}: {
  lab: Lab;
  status?: LabStatus;
  busy?: boolean;
  loggedIn: boolean;
  /** Logged out: the start button logs in instead of being greyed out. */
  onLogin?: () => Promise<void>;
  hostArch: string;
  onOpen: () => void;
  onStop: () => void;
  /** Brings a paused or shut-down lab back as it was. */
  onResume?: () => void;
  /** The player already solved it (website evidence). */
  solved?: boolean;
  /** What this machine is missing to run it (see lab-readiness), or null. */
  setup?: string | null;
}) {
  const rt = lab.runtime;
  const native = rt?.architectures.includes(hostArch) ?? true;
  const running = status?.running ?? false;
  const parked = !running && (status?.parked ?? null);
  const RuntimeIcon = rt?.runtime === "VM" ? Monitor : Container;

  return (
    <div
      onClick={onOpen}
      className="group flex cursor-pointer items-center gap-3 border-t border-border px-4 py-3 transition-colors first:border-t-0 hover:bg-[#0e0e0e]"
    >
      <span className="grid size-[1.875rem] shrink-0 place-items-center rounded-lg border border-border bg-[#121212] text-muted-foreground">
        <RuntimeIcon className="size-4" />
      </span>

      <div className="w-56 shrink-0">
        <p className="flex items-center gap-1.5 truncate text-[0.84375rem] font-medium text-foreground">
          {solved && <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-label="Solved" />}
          <span className="truncate">{lab.title}</span>
        </p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[0.71875rem] text-muted-foreground">
          {lab.difficulty > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", DIFFICULTY_DOT[lab.difficulty])} />
              {DIFFICULTY_LABEL[lab.difficulty]}
            </span>
          )}
          <span className="truncate">· {lab.category}</span>
        </div>
      </div>

      {/* Actions sit before the place icons, so the icons and the chevron stay put on every row
          and a Stop or Resume button grows into the empty middle instead of shifting them. */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {running ? (
          <>
            {status?.url && (
              <RowButton tone="learn" onClick={() => openExternal(status.url!)}>
                <ExternalLink className="size-3" /> Open
              </RowButton>
            )}
            <RowButton tone="danger" onClick={onStop} disabled={busy}>
              {busy ? "Stopping…" : "Stop"}
            </RowButton>
          </>
        ) : parked ? (
          <>
            <span className="text-[0.6875rem] text-muted-foreground">{parked === "pause" ? "Paused" : "Shut down"}</span>
            {onResume && (
              <RowButton tone="learn" onClick={onResume} disabled={busy} title="Bring it back as it was">
                {busy ? "Resuming…" : "Resume"}
              </RowButton>
            )}
          </>
        ) : setup ? (
          <RowButton onClick={() => machineOpenSetup().catch(tell("Couldn't open machine setup"))} title="Open machine setup">
            <Wrench className="size-3" /> {setup}
          </RowButton>
        ) : !loggedIn && onLogin ? (
          <RowButton tone="learn" onClick={() => void onLogin().catch(tell("Couldn't start signing in"))} title="Sign in to start labs">
            <LogIn className="size-3" /> Sign in
          </RowButton>
        ) : null}
        {/* Starting happens on the lab's own page, where you pick where to run; the row opens it. */}

        {rt && (
          <span className="hidden items-center gap-1.5 text-[0.6875rem] text-muted-foreground lg:inline-flex">
            {!native && <span className="text-amber-500">emulated</span>}
            <span className="inline-flex items-center gap-1">
              {/* Every place is shown: where it runs (emerald), where it can (accent), and where
                  it can't (greyed), so the row reads as the full set of options at a glance. */}
              {runPlaces(rt, hostArch).map(({ key, icon: Icon, label, available }) => {
                const inUse = running && status?.place === key;
                const hint = inUse ? `Running on: ${status?.host ?? label}` : available ? `Can run on: ${label}` : `Not available: ${label}`;
                return (
                  <span key={key} title={hint} aria-label={hint} className="inline-flex">
                    <Icon className={cn("size-3", inUse ? "text-emerald-500" : available ? "text-learn" : "text-muted-foreground/60")} />
                  </span>
                );
              })}
            </span>
          </span>
        )}

        <ChevronRight className="size-4 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
      </div>
    </div>
  );
}
