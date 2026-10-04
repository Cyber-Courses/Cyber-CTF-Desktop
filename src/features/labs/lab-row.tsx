"use client";

import { CheckCircle2, ChevronRight, Cloud, Container, ExternalLink, Globe, Monitor, Play, Server, Wrench, type LucideIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Spinner } from "@/components/ui/spinner";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/features/labs/use-labs";
import { CLOUDS } from "@/features/labs/run-on";
import { machineOpenSetup, type LabStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";
import { Button } from "@/components/ui/button";

const SERVERS = new Set(["vmware_esxi", "proxmox"]);

/** Every place a lab could run besides its default runtime here, and whether this one can (from its providers). */
function runPlaces(rt: NonNullable<Lab["runtime"]>): { icon: LucideIcon; label: string; available: boolean }[] {
  // providers also carries "hosted" (not a launcher Provider), so compare as strings.
  const local = rt.providers.some((p: string) => !SERVERS.has(p) && !CLOUDS.has(p) && p !== "hosted");
  return [
    { icon: Monitor, label: "VM on this machine", available: rt.runtime === "DOCKER" && local },
    { icon: Server, label: "Your server", available: rt.providers.some((p) => SERVERS.has(p)) },
    { icon: Cloud, label: "Your cloud account", available: rt.providers.some((p) => CLOUDS.has(p)) },
    { icon: Globe, label: "Hosted by Cyber CTF", available: rt.hosted ?? false },
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
 * One lab as a dense list row: runtime glyph, title + difficulty/category, description,
 * and the contextual action (Start, or Open + Running) with a chevron into the detail.
 * Reused on the Overview rail-list and the full Labs list.
 */
export function LabRow({
  lab,
  status,
  busy = false,
  loggedIn,
  hostArch,
  onOpen,
  onStart,
  onStop,
  showDescription = true,
  solved = false,
  setup = null,
}: {
  lab: Lab;
  status?: LabStatus;
  busy?: boolean;
  loggedIn: boolean;
  hostArch: string;
  onOpen: () => void;
  onStart: () => void;
  onStop: () => void;
  showDescription?: boolean;
  /** The player already solved it (website evidence). */
  solved?: boolean;
  /** What this machine is missing to run it (see lab-readiness), or null. */
  setup?: string | null;
}) {
  const rt = lab.runtime;
  const native = rt?.architectures.includes(hostArch) ?? true;
  const running = status?.running ?? false;
  const RuntimeIcon = rt?.runtime === "VM" ? Server : Container;

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

      {showDescription && lab.description && <p className="hidden flex-1 truncate text-[0.78125rem] text-muted-foreground lg:block">{lab.description}</p>}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {rt && (
          <span className="hidden items-center gap-1.5 text-[0.6875rem] text-muted-foreground xl:inline-flex">
            <RuntimeIcon className="size-3" />
            {rt.runtime === "VM" ? "VM" : "Container"}
            {!native && <span className="text-amber-500">· emulated</span>}
            <span className="ml-0.5 inline-flex items-center gap-1">
              {runPlaces(rt).map(({ icon: Icon, label, available }) => {
                const hint = available ? `Runs on: ${label}` : `Not available: ${label}`;
                return (
                  <span key={label} title={hint} aria-label={hint} className="inline-flex">
                    <Icon className={cn("size-3", available ? "text-foreground/80" : "text-muted-foreground/25")} />
                  </span>
                );
              })}
            </span>
          </span>
        )}

        {running ? (
          <>
            <span className="hidden items-center gap-1.5 text-[0.6875rem] text-emerald-500 sm:inline-flex">
              <span className="size-1.5 rounded-full bg-emerald-500" /> on {status?.host ?? "this machine"}
            </span>
            {status?.url && (
              <RowButton tone="learn" onClick={() => openUrl(status.url!).catch(() => {})}>
                <ExternalLink className="size-3" /> Open
              </RowButton>
            )}
            <RowButton tone="danger" onClick={onStop} disabled={busy}>
              {busy ? "Stopping…" : "Stop"}
            </RowButton>
          </>
        ) : setup ? (
          <RowButton onClick={() => machineOpenSetup().catch(() => {})} title="Open machine setup">
            <Wrench className="size-3" /> {setup}
          </RowButton>
        ) : (
          <RowButton
            tone="learn"
            onClick={onStart}
            disabled={!loggedIn || !rt || busy}
            title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}
          >
            {busy ? <Spinner className="size-3" /> : <Play className="size-3" />} Start
          </RowButton>
        )}

        <ChevronRight className="size-4 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
      </div>
    </div>
  );
}
