"use client";

import { CheckCircle2, ChevronRight, Container, ExternalLink, Play, Server, Wrench } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Spinner } from "@/components/ui/spinner";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, type Lab } from "@/lib/use-labs";
import { machineOpenSetup, type LabStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** A compact, Vercel-style action button used inside dense rows. */
function MiniButton({
  children,
  onClick,
  disabled,
  tone = "default",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "learn" | "danger";
  title?: string;
}) {
  const tones = {
    default: "border-border bg-card text-foreground hover:border-ring/60",
    learn: "border-white/10 bg-learn-solid text-white font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.16)] hover:bg-learn-solid-hover active:bg-learn-solid-active",
    danger: "border-transparent bg-destructive/12 text-destructive hover:bg-destructive/20",
  };
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40",
        tones[tone],
      )}
    >
      {children}
    </button>
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
      <span className="grid size-[30px] shrink-0 place-items-center rounded-lg border border-border bg-[#121212] text-muted-foreground">
        <RuntimeIcon className="size-4" />
      </span>

      <div className="w-56 shrink-0">
        <p className="flex items-center gap-1.5 truncate text-[0.84375rem] font-medium text-foreground">
          {solved && <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-label="Solved" />}
          <span className="truncate">{lab.title}</span>
        </p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {lab.difficulty > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", DIFFICULTY_DOT[lab.difficulty])} />
              {DIFFICULTY_LABEL[lab.difficulty]}
            </span>
          )}
          <span className="truncate">· {lab.category}</span>
        </div>
      </div>

      {showDescription && lab.description && (
        <p className="hidden flex-1 truncate text-[12.5px] text-muted-foreground lg:block">{lab.description}</p>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {rt && (
          <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground xl:inline-flex">
            <RuntimeIcon className="size-3" />
            {rt.runtime === "VM" ? "VM" : "Container"}
            {!native && <span className="text-amber-500">· emulated</span>}
          </span>
        )}

        {running ? (
          <>
            <span className="hidden items-center gap-1.5 text-[0.6875rem] text-emerald-500 sm:inline-flex">
              <span className="size-1.5 rounded-full bg-emerald-500" /> on {status?.host ?? "this machine"}
            </span>
            {status?.url && (
              <MiniButton tone="learn" onClick={() => openUrl(status.url!).catch(() => {})}>
                <ExternalLink className="size-3" /> Open
              </MiniButton>
            )}
            <MiniButton tone="danger" onClick={onStop} disabled={busy}>
              {busy ? "Stopping…" : "Stop"}
            </MiniButton>
          </>
        ) : setup ? (
          <MiniButton onClick={() => machineOpenSetup().catch(() => {})} title="Open machine setup">
            <Wrench className="size-3" /> {setup}
          </MiniButton>
        ) : (
          <MiniButton
            tone="learn"
            onClick={onStart}
            disabled={!loggedIn || !rt || busy}
            title={!rt ? "No runtime for this lab yet" : loggedIn ? undefined : "Log in to start labs"}
          >
            {busy ? <Spinner className="size-3" /> : <Play className="size-3" />} Start
          </MiniButton>
        )}

        <ChevronRight className="size-4 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
      </div>
    </div>
  );
}
