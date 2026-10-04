"use client";

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Boxes, ChevronDown, ExternalLink, Globe, LogIn, Server, Square, X, Zap } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL } from "@/features/labs/use-labs";
import { useHostedLabs, type HostedLab, type HostedState } from "@/features/hosted/use-hosted-labs";

type Tab = "labs";

/** The human stage of a starting session, for the progress line. */
const STAGE: Partial<Record<HostedState, string>> = { REQUESTED: "Queued", CLAIMED: "Queued", PULLING: "Building your lab" };

/** Hosted labs: web labs Cyber CTF runs on its own infrastructure (a Vercel Sandbox microVM
 *  running the lab's compose). The player opens the public URLs in a browser. Degrades to a
 *  short explainer when the backend doesn't expose the hosted API yet. */
export function HostedScreen({ onNavigate, loggedIn }: { onNavigate: (tab: Tab) => void; loggedIn: boolean }) {
  const { labs, available, session, busyLab, error, launch, stop } = useHostedLabs();
  const [activeLab, setActiveLab] = useState<HostedLab | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  const start = (lab: HostedLab) => {
    setActiveLab(lab);
    launch(lab.id);
  };
  const end = () => {
    setActiveLab(null);
    stop();
  };
  // One session per player; launching is blocked while one is live or starting.
  const sessionBusy = !!session && session.state !== "FAILED";
  const starting = !!session && (session.state === "REQUESTED" || session.state === "CLAIMED" || session.state === "PULLING");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-[#121212] text-muted-foreground">
          <Globe className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[0.9375rem] font-semibold tracking-tight">Hosted labs</h1>
            <span className="rounded border border-border px-1.5 text-[0.5625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
              Early access
            </span>
          </div>
          <p className="mt-0.5 text-[0.75rem] text-muted-foreground">We run the lab on Cyber CTF&rsquo;s infrastructure; you just open it in your browser.</p>
        </div>
      </div>

      {error && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-[0.75rem] text-destructive">{error}</p>}

      {/* Active session */}
      {session && (
        <div
          className={cn(
            "rounded-xl border p-4",
            session.state === "RUNNING"
              ? "border-emerald-500/30 bg-emerald-500/[0.04]"
              : session.state === "FAILED"
                ? "border-destructive/30 bg-destructive/[0.04]"
                : "border-learn/30 bg-learn/[0.04]",
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              {session.state === "RUNNING" ? (
                <>
                  <p className="flex items-center gap-1.5 text-[0.84375rem] font-medium">
                    <span className="size-1.5 rounded-full bg-emerald-500" /> {activeLab?.title ?? "Your lab"} is running
                  </p>
                  <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                    Open it in your browser and attack it with your own tools. {expiresIn(session.expiresAt)}
                  </p>
                </>
              ) : session.state === "FAILED" ? (
                <>
                  <p className="flex items-center gap-1.5 text-[0.84375rem] font-medium text-destructive">
                    <X className="size-3.5" /> Couldn&rsquo;t start {activeLab?.title ?? "the lab"}
                  </p>
                  <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{session.message ?? "The lab failed to start. Try again in a moment."}</p>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 text-[0.84375rem] font-medium">
                    <Spinner className="size-4" /> Starting {activeLab?.title ?? "your lab"}…
                  </p>
                  <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{STAGE[session.state] ?? "Starting"}. This usually takes about 30 seconds.</p>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {session.state === "RUNNING" &&
                session.endpoints.map((e) => (
                  <Button key={e.port} variant="learn" size="sm" onClick={() => openUrl(e.url).catch(() => {})}>
                    Open{session.endpoints.length > 1 ? ` :${e.port}` : ""} <ExternalLink className="size-3.5" />
                  </Button>
                ))}
              <Button variant="outline" size="sm" onClick={end}>
                {session.state === "FAILED" ? (
                  "Dismiss"
                ) : (
                  <>
                    <Square className="size-3.5" /> Stop
                  </>
                )}
              </Button>
            </div>
          </div>
          {starting && <Stepper state={session.state} />}
        </div>
      )}

      {/* Labs */}
      {available === false ? (
        <Panel>
          <div className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-[0.8125rem] font-medium">Hosted labs aren&rsquo;t live yet</p>
              <p className="mt-0.5 text-[0.75rem] text-muted-foreground">They&rsquo;re coming soon. For now, run labs on this machine or your own server.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onNavigate("labs")}>
              Browse labs <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader title={labs && labs.length > 0 ? `Hosted labs (${labs.length})` : "Hosted labs"} />
          {labs === null ? (
            <div className="flex items-center gap-2 px-4 py-4 text-[0.78125rem] text-muted-foreground">
              <Spinner className="size-4" /> Loading hosted labs…
            </div>
          ) : labs.length === 0 ? (
            <EmptyRow title="No hosted labs published yet" body="Hosted web labs will appear here once published." onNavigate={onNavigate} />
          ) : (
            <>
              {!loggedIn && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-amber-500/[0.06] px-4 py-2.5 text-[0.75rem] text-amber-500/90">
                  <LogIn className="size-3.5" /> Sign in from the top bar to run a hosted lab.
                </div>
              )}
              {labs.map((lab) => (
                <LabRow
                  key={lab.id}
                  lab={lab}
                  loggedIn={loggedIn}
                  disabled={sessionBusy || busyLab !== null}
                  busy={busyLab === lab.id}
                  onLaunch={() => start(lab)}
                />
              ))}
            </>
          )}
        </Panel>
      )}

      {/* How it works (collapsed once there are labs) */}
      <Panel>
        <button
          type="button"
          onClick={() => setHowOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
        >
          <span className="text-[0.8125rem] font-medium">How hosted labs work</span>
          <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", howOpen && "rotate-180")} />
        </button>
        {howOpen && (
          <div className="border-t border-border">
            <div className="grid gap-px bg-border sm:grid-cols-3">
              <Fit icon={Zap} title="Hosted" body="Zero setup. Best for quick web labs, or when your machine can’t run them." active />
              <Fit icon={Server} title="Server" body="Heavy multi-VM labs on your own ESXi / Proxmox." />
              <Fit icon={Boxes} title="This machine" body="Container labs locally via Docker." />
            </div>
            <p className="px-4 py-3 text-[0.71875rem] leading-relaxed text-muted-foreground">
              Launch starts your own isolated copy on our infrastructure (not shared with anyone), gives you public URLs to open in a browser, and tears it down
              when you stop it or after two hours.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** One hosted lab as a dense row, matching the Labs list. */
function LabRow({ lab, loggedIn, disabled, busy, onLaunch }: { lab: HostedLab; loggedIn: boolean; disabled: boolean; busy: boolean; onLaunch: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <span className="grid size-[1.875rem] shrink-0 place-items-center rounded-lg border border-border bg-[#121212] text-muted-foreground">
        <Globe className="size-4" />
      </span>
      <div className="w-56 shrink-0">
        <p className="truncate text-[0.84375rem] font-medium text-foreground">{lab.title}</p>
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
      {lab.description && <p className="hidden flex-1 truncate text-[0.78125rem] text-muted-foreground lg:block">{lab.description}</p>}
      <Button
        className="ml-auto shrink-0"
        size="xs"
        variant="learn"
        disabled={!loggedIn || disabled}
        onClick={onLaunch}
        title={loggedIn ? undefined : "Sign in to run hosted labs"}
      >
        {busy ? <Spinner className="size-3" /> : <Zap className="size-3" />} Launch
      </Button>
    </div>
  );
}

/** Three-stage progress for a starting session. */
function Stepper({ state }: { state: HostedState }) {
  const steps = ["Queued", "Building", "Ready"] as const;
  const at = state === "PULLING" ? 1 : state === "RUNNING" ? 2 : 0;
  return (
    <div className="mt-3 flex items-center gap-2">
      {steps.map((label, i) => (
        <div key={label} className="flex flex-1 items-center gap-2">
          <span className={cn("size-1.5 rounded-full", i < at ? "bg-emerald-500" : i === at ? "bg-learn" : "bg-border")} />
          <span className={cn("text-[0.6875rem]", i <= at ? "text-foreground" : "text-muted-foreground")}>{label}</span>
          {i < steps.length - 1 && <span className={cn("h-px flex-1", i < at ? "bg-emerald-500/50" : "bg-border")} />}
        </div>
      ))}
    </div>
  );
}

function EmptyRow({ title, body, onNavigate }: { title: string; body: string; onNavigate: (tab: Tab) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-[0.8125rem] font-medium">{title}</p>
        <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{body} For now, run labs on this machine or your own server.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => onNavigate("labs")}>
        Browse labs <ArrowRight className="size-3.5" />
      </Button>
    </div>
  );
}

/** "expires in Xh Ym" from an ISO timestamp, or empty when past/absent. */
function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `Expires in ${h > 0 ? `${h}h ` : ""}${m}m.`;
}

function Fit({ icon: Icon, title, body, active }: { icon: typeof Globe; title: string; body: string; active?: boolean }) {
  return (
    <div className="bg-card p-4">
      <p className={cn("flex items-center gap-1.5 text-[0.78125rem] font-medium", active ? "text-learn" : "text-foreground")}>
        <Icon className="size-3.5" /> {title}
      </p>
      <p className="mt-1 text-[0.71875rem] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
