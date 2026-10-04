"use client";

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Boxes, CheckCircle2, ExternalLink, Globe, MousePointerClick, Server, Square, Zap } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useHostedLabs, type HostedLab } from "@/features/hosted/use-hosted-labs";

type Tab = "labs";

/** Labs Cyber CTF runs on its own infrastructure (a Vercel Sandbox microVM running the lab's
 *  compose); the player just opens the public URLs in a browser. Distinct from Server (your
 *  hardware) and Cloud (your account). Falls back to a "coming soon" note until the backend
 *  exposes the hosted API. */
export function HostedScreen({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const { labs, available, session, busyLab, error, launch, stop } = useHostedLabs();
  const [activeLab, setActiveLab] = useState<HostedLab | null>(null);

  const start = (lab: HostedLab) => {
    setActiveLab(lab);
    launch(lab.id);
  };
  const end = () => {
    setActiveLab(null);
    stop();
  };
  const sessionBusy = !!session && session.state !== "FAILED";

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-gradient-to-br from-[#141414] to-[#0a0a0a] p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Hosted labs</h1>
            <span className="rounded border border-border px-1.5 text-[0.5625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
              Early access
            </span>
          </div>
          <p className="mt-1 max-w-xl text-[0.8125rem] text-muted-foreground">
            Web labs we run on Cyber CTF&rsquo;s own infrastructure. Open them straight in your browser, nothing to install, download, or run on your machine.
          </p>
        </div>
        <Globe className="hidden size-10 shrink-0 text-muted-foreground/40 sm:block" />
      </div>

      {error && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-[0.75rem] text-destructive">{error}</p>}

      {/* Active session */}
      {session && (
        <Panel>
          <PanelHeader title="Your hosted lab" />
          <div className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              {session.state === "RUNNING" ? (
                <>
                  <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-emerald-500">
                    <CheckCircle2 className="size-3.5" /> {activeLab?.title ?? "Lab"} is running
                  </p>
                  <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                    Open it in your browser and attack it with your own tools. {expiresIn(session.expiresAt)}
                  </p>
                </>
              ) : session.state === "FAILED" ? (
                <>
                  <p className="text-[0.8125rem] font-medium text-destructive">Couldn&rsquo;t start {activeLab?.title ?? "the lab"}</p>
                  <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{session.message ?? "The lab failed to start."}</p>
                </>
              ) : (
                <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
                  <Spinner className="size-4" /> {session.message ?? "Starting your lab"}… ({activeLab?.title ?? "lab"})
                </p>
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
        </Panel>
      )}

      {/* Lab list (live) or the coming-soon placeholder */}
      {available === false ? (
        <>
          <Panel>
            <PanelHeader title="How it works" />
            <Step n={1} icon={MousePointerClick} title="Pick a hosted lab" body="Choose a lab marked “Hosted”, no setup, no local runtime needed." />
            <Step
              n={2}
              icon={Boxes}
              title="We spin up your instance"
              body="Your own isolated copy starts on our infrastructure, not shared with anyone else."
            />
            <Step n={3} icon={Globe} title="Open it in your browser" body="Attack it over the web for the session; we tear it down when you’re done." />
          </Panel>
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
        </>
      ) : (
        <Panel>
          <PanelHeader title="Hosted labs" />
          {labs === null ? (
            <div className="flex items-center gap-2 px-3.5 py-3 text-[0.78125rem] text-muted-foreground">
              <Spinner className="size-4" /> Loading hosted labs…
            </div>
          ) : labs.length === 0 ? (
            <div className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-[0.8125rem] font-medium">No hosted labs published yet</p>
                <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                  Hosted web labs will appear here once published. For now, run labs on this machine or your own server.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => onNavigate("labs")}>
                Browse labs <ArrowRight className="size-3.5" />
              </Button>
            </div>
          ) : (
            labs.map((lab) => (
              <div key={lab.id} className="flex flex-wrap items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="text-[0.8125rem] font-medium">{lab.title}</p>
                  <p className="mt-0.5 truncate text-[0.75rem] text-muted-foreground">{lab.description ?? lab.category}</p>
                </div>
                <Button variant="learn" size="sm" disabled={sessionBusy || busyLab !== null} onClick={() => start(lab)}>
                  {busyLab === lab.id ? <Spinner className="size-3.5" /> : <Zap className="size-3.5" />} Launch
                </Button>
              </div>
            ))
          )}
        </Panel>
      )}

      {/* Where it fits */}
      <Panel>
        <PanelHeader title="When to use it" />
        <div className="grid gap-px bg-border sm:grid-cols-3">
          <Fit icon={Zap} title="Hosted" body="Zero setup. Best for quick web labs, or when your machine can’t run them." active />
          <Fit icon={Server} title="Server" body="Heavy multi-VM labs on your own ESXi / Proxmox." />
          <Fit icon={Boxes} title="This machine" body="Container labs locally via Docker." />
        </div>
      </Panel>
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

function Step({ n, icon: Icon, title, body }: { n: number; icon: typeof Globe; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[0.6875rem] font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium">
          <Icon className="size-3.5 text-muted-foreground" /> {title}
        </p>
        <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function Fit({ icon: Icon, title, body, active }: { icon: typeof Globe; title: string; body: string; active?: boolean }) {
  return (
    <div className="bg-card p-4">
      <p className={`flex items-center gap-1.5 text-[0.78125rem] font-medium ${active ? "text-learn" : "text-foreground"}`}>
        <Icon className="size-3.5" /> {title}
      </p>
      <p className="mt-1 text-[0.71875rem] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
