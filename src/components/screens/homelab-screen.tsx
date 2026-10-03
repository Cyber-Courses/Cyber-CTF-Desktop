"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, CheckCircle2, Pencil, Plus, Server, Star, Trash2, XCircle, Zap } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { KIND } from "@/components/homelab/host-setup";
import {
  HOMELAB_CHANGED,
  homelabList,
  homelabOpenSetup,
  homelabRemove,
  homelabSetDefault,
  homelabTest,
  type HomelabHost,
  type HomelabTest,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "setup";

export function HomeLabScreen({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const [hosts, setHosts] = useState<HomelabHost[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
    const [tests, setTests] = useState<Record<string, HomelabTest | "testing">>({});

  const reload = useCallback(() => {
    homelabList()
      .then((l) => {
        setHosts(l.hosts);
        setDefaultId(l.default);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);
  // The setup window saves hosts; refresh when it says so.
  useEffect(() => {
    const off = listen(HOMELAB_CHANGED, reload);
    return () => {
      off.then((f) => f()).catch(() => {});
    };
  }, [reload]);

  const test = useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const r = await homelabTest(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) } }));
    }
  }, []);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Home lab</h1>
          <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
            Run heavy, multi-VM labs on your own ESXi or Proxmox server instead of this machine. Credentials stay in your OS keychain.
          </p>
        </div>
        <Button variant="learn" size="sm" onClick={() => homelabOpenSetup(null).catch((e) => setError(String(e)))}>
          <Plus className="size-3.5" /> Add host
        </Button>
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

      <Panel>
        <PanelHeader title="Hosts" action={hosts && hosts.length > 0 ? <span className="text-[11.5px] text-muted-foreground">VM labs run on the default host unless you pick another</span> : undefined} />
        {hosts === null ? (
          <div className="flex items-center gap-2 px-3.5 py-4 text-[12.5px] text-muted-foreground"><Spinner className="size-4" /> Loading…</div>
        ) : hosts.length === 0 ? (
          <div className="px-3.5 py-8 text-center">
            <Server className="mx-auto size-6 text-muted-foreground/50" />
            <p className="mt-2 text-[13px] font-medium">No host connected</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">Add your Proxmox or ESXi server to run VM labs on it.</p>
          </div>
        ) : (
          hosts.map((h) => (
            <HostRow
              key={h.id}
              host={h}
              isDefault={h.id === defaultId}
              test={tests[h.id]}
              onTest={() => test(h.id)}
              onEdit={() => homelabOpenSetup(h.id).catch((e) => setError(String(e)))}
              onDefault={() => act(() => homelabSetDefault(h.id === defaultId ? null : h.id))}
              onRemove={() => {
                if (confirm(`Remove ${h.name}? Its password is deleted from the keychain.`)) act(() => homelabRemove(h.id));
              }}
            />
          ))
        )}
      </Panel>

      <Panel>
        <PanelHeader title="How it works" />
        <Step n={1} title="Connect your host" body="Add the endpoint and an account. The launcher checks it's reachable (and signs in, for Proxmox)." />
        <Step n={2} title="Pick where a VM lab runs" body="On a VM lab, choose This machine or one of your hosts. Labs launched from the website use the default host." />
        <Step n={3} title="Vagrant builds it there" body="The launcher runs Vagrant with your host's connection; the VMs are created, and destroyed on Stop, on your server." />
      </Panel>

      <Panel>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">No server?</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">If this machine can handle it, install a local hypervisor and run VM labs here.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate("setup")}>
            Go to Setup <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function HostRow({
  host,
  isDefault,
  test,
  onTest,
  onEdit,
  onDefault,
  onRemove,
}: {
  host: HomelabHost;
  isDefault: boolean;
  test: HomelabTest | "testing" | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDefault: () => void;
  onRemove: () => void;
}) {
  const result = test && test !== "testing" ? test : null;
  const ok = result ? result.ok : null;
  return (
    <div className="border-b border-border px-3.5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className={cn("size-2 shrink-0 rounded-full", ok === null ? "bg-muted-foreground/40" : ok ? "bg-emerald-500" : "bg-rose-500")} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <span className="truncate">{host.name}</span>
            {isDefault && <span className="rounded border border-border px-1.5 text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">Default</span>}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {KIND[host.provider].label} · {host.username}@{host.host}:{host.port}
            {host.node ? ` · node ${host.node}` : ""}
            {result?.latencyMs != null ? ` · ${result.latencyMs} ms` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={onTest} disabled={test === "testing"}>
            {test === "testing" ? <Spinner className="size-3.5" /> : <Zap className="size-3.5" />} Test
          </Button>
          <IconButton label={isDefault ? "Unset default" : "Make default"} onClick={onDefault}>
            <Star className={cn("size-3.5", isDefault && "fill-current text-learn")} />
          </IconButton>
          <IconButton label="Edit" onClick={onEdit}><Pencil className="size-3.5" /></IconButton>
          <IconButton label="Remove" onClick={onRemove}><Trash2 className="size-3.5" /></IconButton>
        </div>
      </div>
      {result && (
        <p className={cn("mt-2 flex items-start gap-1.5 pl-5 text-[12px]", ok ? "text-emerald-500" : "text-rose-400")}>
          {ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
          <span>{result.message}</span>
        </p>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-medium text-muted-foreground">{n}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
