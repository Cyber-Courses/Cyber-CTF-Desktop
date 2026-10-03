"use client";

import { ArrowRight, Network, Plug, Server, Wrench } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import type { ProviderStatus, SystemReport } from "@/lib/tauri";

type Tab = "setup";

const REMOTE_LABELS: Record<string, { label: string; note: string }> = {
  vmware_esxi: { label: "VMware ESXi", note: "Standalone ESXi host" },
  proxmox: { label: "Proxmox VE", note: "Proxmox cluster or node" },
};

function label(p: ProviderStatus) {
  return REMOTE_LABELS[p.provider]?.label ?? p.provider;
}
function note(p: ProviderStatus) {
  return REMOTE_LABELS[p.provider]?.note ?? "Remote hypervisor";
}

export function HomeLabScreen({ report, onNavigate }: { report: SystemReport | null; onNavigate: (tab: Tab) => void }) {
  const remote = report?.vmProviders.filter((p) => p.remote) ?? [];

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-gradient-to-br from-[#141414] to-[#0a0a0a] p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Home lab</h1>
            <span className="rounded border border-border px-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">Early access</span>
          </div>
          <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
            Run heavier, multi-VM labs on your own hardware. Point the launcher at an ESXi or Proxmox host and offload the big
            network labs from your laptop, your machine stays free while the lab runs on the server.
          </p>
        </div>
        <Server className="hidden size-10 shrink-0 text-muted-foreground/40 sm:block" />
      </div>

      {/* Providers */}
      <div>
        <Panel>
          <PanelHeader title="Connect a hypervisor" action={<span className="text-[11.5px] text-muted-foreground">Coming soon</span>} />
          {remote.length === 0 ? (
            <p className="px-3.5 py-4 text-[12.5px] text-muted-foreground">Checking supported hypervisors…</p>
          ) : (
            remote.map((p) => (
              <div key={p.provider} className="flex items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
                  <Server className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{label(p)}</p>
                  <p className="text-[11.5px] text-muted-foreground">{note(p)}</p>
                </div>
                <Button variant="outline" size="sm" disabled title="Connecting your own host is coming soon">
                  <Plug className="size-3.5" /> Connect
                </Button>
              </div>
            ))
          )}
        </Panel>
      </div>

      {/* How it will work */}
      <div>
        <Panel>
          <PanelHeader title="How it will work" />
          <Step n={1} icon={Plug} title="Connect your host" body="Add an ESXi or Proxmox endpoint and credentials, kept in your OS keychain." />
          <Step n={2} icon={Wrench} title="We provision the VMs" body="Lab VMs are built on your server with Vagrant and configured with Ansible." />
          <Step n={3} icon={Network} title="Attack from here" body="The lab runs on the server; you open and attack it from the launcher like any other lab." />
        </Panel>
      </div>

      {/* Today */}
      <Panel>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">Today: run VM labs locally</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">If your machine can handle it, install a local hypervisor and run VM labs now. Home-lab offload lands later.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate("setup")}>
            Go to Setup <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function Step({ n, icon: Icon, title, body }: { n: number; icon: typeof Plug; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium text-muted-foreground">{n}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] font-medium"><Icon className="size-3.5 text-muted-foreground" /> {title}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
