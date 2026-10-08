"use client";

import { ChevronRight, Cloud, Container, ExternalLink, Globe, LogIn, Monitor, Server, Wrench, type LucideIcon } from "lucide-react";
import { DIFFICULTY_LABEL, type Lab } from "@/features/labs/use-labs";
import { CLOUDS } from "@/features/labs/run-on";
import { machineOpenSetup, type LabStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useState, type ButtonHTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { LevelBadge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-pill";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OPERATION_STATUS } from "@/lib/deploy-store";
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
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { tone?: "default" | "primary" | "danger"; onClick: () => void }) {
  const variant = tone === "primary" ? "primary" : tone === "danger" ? "destructive" : "outline";
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
 * One lab as a dense 3.25rem list row: a status dot, the title over mono meta, then mono columns
 * (category, level, runtime with the run-place icons), the row action (Open and Stop while it
 * runs, Resume when parked, setup or sign-in when needed) and a chevron into the detail
 * (starting happens on the lab's own page). The secondary columns fold away in a narrow
 * container. Reused on the Overview rail-list and the full Labs list.
 */
export function LabRow({
  lab,
  status,
  busy = false,
  operation,
  loggedIn,
  onLogin,
  hostArch,
  onOpen,
  onStop,
  onResume,
  solved = false,
  setup = null,
  deploying = false,
}: {
  lab: Lab;
  status?: LabStatus;
  busy?: boolean;
  /** The operation in flight while `busy` (launch, stop, shutdown…), for its label. */
  operation?: string;
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
  /** A deploy is running for it in the backend (e.g. started before a reload), for the dot. */
  deploying?: boolean;
}) {
  const rt = lab.runtime;
  // Unknown host (report not in yet) or a lab for any CPU: native, never a wrong "emulated".
  const native = !hostArch || !rt || runsNatively(rt, hostArch);
  const running = status?.running ?? false;
  const parked = !running && (status?.parked ?? null);
  // While busy, what is actually happening: a lab being started reports running long before
  // the launch is done, so "Stopping…" there would be wrong.
  const doing = busy ? `${(operation && OPERATION_STATUS[operation]) ?? "Working"}…` : null;
  // Stop deletes the lab's machines: ask first, as the lab's own page does.
  const [confirmingStop, setConfirmingStop] = useState(false);
  const stateLabel = busy
    ? doing
    : deploying && !running
      ? "Starting…"
      : running
        ? "Running"
        : parked
          ? parked === "pause"
            ? "Paused"
            : "Shut down"
          : solved
            ? "Solved"
            : "Not started";

  return (
    <div className="@container border-t border-border first:border-t-0">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${lab.title}`}
        onClick={onOpen}
        onKeyDown={(e) => {
          // Only the row itself: Enter on one of its buttons (or in its dialog) is theirs.
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onOpen();
        }}
        className="group grid h-13 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_1rem] items-center gap-3.5 px-4 text-[0.8125rem] outline-none transition-colors hover:bg-glass focus-visible:bg-glass focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[44rem]:grid-cols-[auto_minmax(0,1fr)_8rem_5.5rem_7rem_9.5rem_1rem]"
      >
        <span title={stateLabel ?? undefined} className="flex w-2 justify-center">
          {busy || (deploying && !running) ? (
            <StatusDot tone="warn" pulse />
          ) : running ? (
            <StatusDot tone="ok" />
          ) : solved ? (
            <span aria-hidden className="dot dot-jewel" />
          ) : (
            <StatusDot tone="muted" />
          )}
          <span className="sr-only">{stateLabel}</span>
        </span>

        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground">{lab.title}</span>
          <span className="block truncate font-mono text-[0.6875rem] text-faint">
            {lab.slug}
            {!native && (
              <>
                {" · "}
                <span className="text-warning" title="Built for another CPU: runs emulated (slower)">
                  emulated
                </span>
              </>
            )}
            {setup && !running ? (
              <>
                {" · "}
                <span className="text-warning">{setup}</span>
              </>
            ) : (
              ` · ${lab.description || lab.category}`
            )}
          </span>
        </span>

        <span className="hidden truncate font-mono text-[0.6875rem] text-faint @min-[44rem]:block">{lab.category}</span>
        <span className="hidden @min-[44rem]:block">
          {lab.difficulty > 0 && <LevelBadge level={lab.difficulty}>{DIFFICULTY_LABEL[lab.difficulty]}</LevelBadge>}
        </span>
        <span className="hidden items-center gap-2 font-mono text-[0.6875rem] text-faint @min-[44rem]:flex">
          {rt && (
            <>
              <span>{rt.runtime === "VM" ? "vm" : "docker"}</span>
              <span className="inline-flex items-center gap-1">
                {/* Every place is shown: where it runs (green), where it can (jewel), and where
                    it can't (greyed), so the row reads as the full set of options at a glance. */}
                {runPlaces(rt, hostArch).map(({ key, icon: Icon, label, available }) => {
                  const inUse = running && status?.place === key;
                  const hint = inUse ? `Running on: ${status?.host ?? label}` : available ? `Can run on: ${label}` : `Not available: ${label}`;
                  return (
                    <span key={key} title={hint} aria-label={hint} className="inline-flex">
                      <Icon className={cn("size-3", inUse ? "text-success" : available ? "text-jewel-text" : "text-faint opacity-50")} />
                    </span>
                  );
                })}
              </span>
            </>
          )}
        </span>

        <span className="flex items-center justify-end gap-1.5">
          {running ? (
            <>
              {status?.url && (
                <RowButton onClick={() => openExternal(status.url!)}>
                  <ExternalLink className="size-3" /> Open
                </RowButton>
              )}
              <RowButton tone="danger" onClick={() => setConfirmingStop(true)} disabled={busy}>
                {doing ?? "Stop"}
              </RowButton>
            </>
          ) : parked ? (
            <>
              <span className="hidden font-mono text-[0.6875rem] text-faint @min-[30rem]:inline">{parked === "pause" ? "paused" : "shut down"}</span>
              {onResume && (
                <RowButton onClick={onResume} disabled={busy} title="Bring it back as it was">
                  {doing ?? "Resume"}
                </RowButton>
              )}
            </>
          ) : setup ? (
            <RowButton onClick={() => machineOpenSetup().catch(tell("Couldn't open machine setup"))} title={`${setup}: open machine setup`}>
              <Wrench className="size-3" /> Set up
            </RowButton>
          ) : !loggedIn && onLogin ? (
            <RowButton onClick={() => void onLogin().catch(tell("Couldn't start signing in"))} title="Sign in to start labs">
              <LogIn className="size-3" /> Sign in
            </RowButton>
          ) : null}
          {/* Starting happens on the lab's own page, where you pick where to run; the row opens it. */}
        </span>

        <ChevronRight className="size-4 text-faint transition-colors group-hover:text-foreground" />
      </div>

      {confirmingStop && (
        // Clicks in the dialog stay in it: the row behind would open the lab.
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            title={`Remove ${lab.title}?`}
            confirmLabel="Remove"
            onCancel={() => setConfirmingStop(false)}
            onConfirm={() => {
              setConfirmingStop(false);
              onStop();
            }}
          >
            Its machines and your attack box are deleted, with everything changed or saved on them. The next start rebuilds the lab from scratch.
            {!status?.host && status?.place !== "local_vm" && " To keep them, open the lab and shut it down instead."}
          </ConfirmDialog>
        </div>
      )}
    </div>
  );
}
