"use client";

import { ChevronRight, Cloud, Container, ExternalLink, Globe, LogIn, Monitor, Server, Wrench, type LucideIcon } from "lucide-react";
import { difficultyLabel, type Lab } from "@/features/labs/use-labs";
import { CLOUDS } from "@/features/labs/run-on";
import { machineOpenSetup, type LabStatus, type Provider, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useState, type ButtonHTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { LevelBadge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-pill";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OPERATION_STATUS } from "@/lib/deploy-store";
import { openExternal, tell } from "@/lib/failure";
import { useT } from "@/lib/i18n";

const SERVERS = new Set(["vmware_esxi", "proxmox"]);

/** Whether the lab is built for this CPU (no architectures listed = any). */
export const runsNatively = (rt: NonNullable<Lab["runtime"]>, hostArch: string) => !rt.architectures.length || rt.architectures.includes(hostArch);

/** Hypervisors that run VMs built for another CPU, emulated (slowly): QEMU runs an x86 lab on
 *  an Apple Silicon Mac. */
export const EMULATORS: readonly Provider[] = ["qemu"];

/** Whether an emulator (QEMU) is ready on this machine: Vagrant, the hypervisor and its plugin. */
export const emulatorReady = (report: SystemReport | null | undefined) =>
  !!report?.vagrant.installed && report.vmProviders.some((p) => EMULATORS.includes(p.provider) && !p.remote && p.available && p.hypervisor !== false);

/** The hypervisors on this machine that can run the lab's VMs: those the lab lists, except for
 *  a VM lab built for another CPU, which only an emulator can run (whatever the lab lists: its
 *  list names the hypervisors of its own CPU). */
export function localProviders(rt: NonNullable<Lab["runtime"]>, hostArch?: string): Provider[] {
  if (rt.runtime === "VM" && hostArch && !runsNatively(rt, hostArch)) return [...EMULATORS];
  return rt.providers.filter((p: string) => !SERVERS.has(p) && !CLOUDS.has(p) && p !== "hosted") as Provider[];
}

type PlaceKey = NonNullable<LabStatus["place"]> | "hosted";

/** Every place a lab could run, and whether this one can (its runtime here, then its providers).
 *  Its words are `labs.places.<key>`.
 *  A VM lab built for another CPU (x86 Windows on Apple Silicon) runs on this machine only
 *  emulated, so "VM on this machine" needs `emulates` (QEMU ready); containers run emulated
 *  anyway. */
export function runPlaces(rt: NonNullable<Lab["runtime"]>, hostArch?: string, emulates = false): { key: PlaceKey; icon: LucideIcon; available: boolean }[] {
  // providers also carries "hosted" (not a launcher Provider), so compare as strings.
  const local = rt.providers.some((p: string) => !SERVERS.has(p) && !CLOUDS.has(p) && p !== "hosted");
  const vm = rt.runtime === "VM";
  return [
    { key: "container", icon: Container, available: !vm },
    { key: "local_vm", icon: Monitor, available: (vm || local) && (!(vm && hostArch && !runsNatively(rt, hostArch)) || emulates) },
    { key: "server", icon: Server, available: rt.providers.some((p) => SERVERS.has(p)) },
    { key: "cloud", icon: Cloud, available: rt.providers.some((p) => CLOUDS.has(p)) },
    { key: "hosted", icon: Globe, available: rt.hosted ?? false },
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
  emulates = false,
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
  /** An emulator (QEMU) is ready here, so a VM lab built for another CPU can run, slowly. */
  emulates?: boolean;
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
  const t = useT();
  const rt = lab.runtime;
  // Unknown host (report not in yet) or a lab for any CPU: native, never a wrong "emulated".
  const native = !hostArch || !rt || runsNatively(rt, hostArch);
  // Emulated only where it actually runs here: containers always, VMs with an emulator ready.
  const emulated = !native && (rt?.runtime !== "VM" || emulates);
  const running = status?.running ?? false;
  const parked = !running && (status?.parked ?? null);
  // While busy, what is actually happening: a lab being started reports running long before
  // the launch is done, so "Stopping…" there would be wrong.
  const doing = busy ? `${(operation && OPERATION_STATUS[operation]) ?? t("labs.state.working")}…` : null;
  // Stop deletes the lab's machines: ask first, as the lab's own page does.
  const [confirmingStop, setConfirmingStop] = useState(false);
  const stateLabel = busy
    ? doing
    : deploying && !running
      ? t("labs.state.startingEllipsis")
      : running
        ? t("labs.state.running")
        : parked
          ? parked === "pause"
            ? t("labs.state.paused")
            : t("labs.state.shutDown")
          : solved
            ? t("labs.state.solved")
            : t("labs.state.notStarted");

  return (
    <div className="@container border-t border-border first:border-t-0">
      <div
        role="button"
        tabIndex={0}
        aria-label={t("labs.row.open", { title: lab.title })}
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
            {emulated && (
              <>
                {" · "}
                <span className="text-warning" title={t("labs.row.emulatedHint")}>
                  {t("labs.row.emulated")}
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
          {lab.difficulty > 0 && <LevelBadge level={lab.difficulty}>{difficultyLabel(t, lab.difficulty)}</LevelBadge>}
        </span>
        <span className="hidden items-center gap-2 font-mono text-[0.6875rem] text-faint @min-[44rem]:flex">
          {rt && (
            <>
              {/* Fixed to the longest label ("docker") so the place icons line up from row to row. */}
              <span className="w-[6ch] shrink-0">{rt.runtime === "VM" ? "vm" : "docker"}</span>
              <span className="inline-flex items-center gap-1">
                {/* Every place is shown: where it runs (green), where it can (jewel), and where
                    it can't (greyed), so the row reads as the full set of options at a glance. */}
                {runPlaces(rt, hostArch, emulates).map(({ key, icon: Icon, available }) => {
                  const label = t(`labs.places.${key}`);
                  const inUse = running && status?.place === key;
                  const hint = inUse
                    ? t("labs.row.runningOn", { where: status?.host ?? label })
                    : available
                      ? t("labs.row.canRunOn", { where: label })
                      : t("labs.row.notAvailable", { where: label });
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
                  <ExternalLink className="size-3" /> {t("labs.row.openButton")}
                </RowButton>
              )}
              <RowButton tone="danger" onClick={() => setConfirmingStop(true)} disabled={busy}>
                {doing ?? t("labs.row.stop")}
              </RowButton>
            </>
          ) : parked ? (
            <>
              <span className="hidden font-mono text-[0.6875rem] text-faint @min-[30rem]:inline">
                {parked === "pause" ? t("labs.row.paused") : t("labs.row.shutDown")}
              </span>
              {onResume && (
                <RowButton onClick={onResume} disabled={busy} title={t("labs.row.resumeHint")}>
                  {doing ?? t("labs.row.resume")}
                </RowButton>
              )}
            </>
          ) : setup ? (
            <RowButton onClick={() => machineOpenSetup().catch(tell(t("labs.row.setupFailed")))} title={t("labs.row.setupHint", { setup })}>
              <Wrench className="size-3" /> {t("labs.row.setUp")}
            </RowButton>
          ) : !loggedIn && onLogin ? (
            <RowButton onClick={() => void onLogin().catch(tell(t("labs.row.signInFailed")))} title={t("labs.row.signInHint")}>
              <LogIn className="size-3" /> {t("labs.row.signIn")}
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
            title={t("labs.row.removeTitle", { title: lab.title })}
            confirmLabel={t("labs.row.remove")}
            onCancel={() => setConfirmingStop(false)}
            onConfirm={() => {
              setConfirmingStop(false);
              onStop();
            }}
          >
            {t("labs.row.removeBody")}
            {!status?.host && status?.place !== "local_vm" && t("labs.row.removeKeep")}
          </ConfirmDialog>
        </div>
      )}
    </div>
  );
}
