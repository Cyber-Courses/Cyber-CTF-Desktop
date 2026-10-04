"use client";

import { ArrowRight, Boxes, Globe, MousePointerClick, Server, Zap } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";

type Tab = "labs";

/** Labs Cyber CTF runs on its own infrastructure, the player just opens them in a browser.
 *  Distinct from Server (your hardware) and Cloud (your account). Backend not built yet. */
export function HostedScreen({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-gradient-to-br from-[#141414] to-[#0a0a0a] p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Hosted labs</h1>
            <span className="rounded border border-border px-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">Early access</span>
          </div>
          <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
            Web labs we run on Cyber CTF&rsquo;s own infrastructure. Open them straight in your browser, nothing to install, download, or run on your machine.
          </p>
        </div>
        <Globe className="hidden size-10 shrink-0 text-muted-foreground/40 sm:block" />
      </div>

      {/* How it works */}
      <Panel>
        <PanelHeader title="How it works" />
        <Step n={1} icon={MousePointerClick} title="Pick a hosted lab" body="Choose a lab marked “Hosted”, no setup, no local runtime needed." />
        <Step n={2} icon={Boxes} title="We spin up your instance" body="Your own isolated copy starts on our infrastructure, not shared with anyone else." />
        <Step n={3} icon={Globe} title="Open it in your browser" body="Attack it over the web for the session; we tear it down when you’re done." />
      </Panel>

      {/* Where it fits */}
      <Panel>
        <PanelHeader title="When to use it" />
        <div className="grid gap-px bg-border sm:grid-cols-3">
          <Fit icon={Zap} title="Hosted" body="Zero setup. Best for quick web labs, or when your machine can’t run them." active />
          <Fit icon={Server} title="Server" body="Heavy multi-VM labs on your own ESXi / Proxmox." />
          <Fit icon={Boxes} title="This machine" body="Container labs locally via Docker." />
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">No hosted labs published yet</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">Hosted web labs are coming. For now, run labs on this machine or your own server.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate("labs")}>
            Browse labs <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function Step({ n, icon: Icon, title, body }: { n: number; icon: typeof Globe; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <Icon className="size-3.5 text-muted-foreground" /> {title}
        </p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function Fit({ icon: Icon, title, body, active }: { icon: typeof Globe; title: string; body: string; active?: boolean }) {
  return (
    <div className="bg-card p-4">
      <p className={`flex items-center gap-1.5 text-[12.5px] font-medium ${active ? "text-learn" : "text-foreground"}`}>
        <Icon className="size-3.5" /> {title}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
