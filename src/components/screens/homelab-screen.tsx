"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, CheckCircle2, Cloud, Pencil, Plus, Server, Star, Trash2, XCircle, Zap } from "lucide-react";
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

const COPY = {
  homelab: {
    title: "Home lab",
    intro: "Run heavy, multi-VM labs on your own ESXi or Proxmox server instead of this machine. Credentials stay in your OS keychain.",
    add: "Add host",
    list: "Hosts",
    hint: "VM labs run on the default host unless you pick another",
    emptyTitle: "No host connected",
    emptyBody: "Add your Proxmox or ESXi server to run labs on it.",
    removed: "password",
  },
  cloud: {
    title: "Cloud",
    intro: "Run labs in your own AWS account: one small EC2 instance per lab, destroyed when you stop it. Keys stay in your OS keychain.",
    add: "Connect AWS",
    list: "Accounts",
    hint: "Pick an account in a lab's Run on choice",
    emptyTitle: "No cloud account connected",
    emptyBody: "Connect an AWS account to run labs in the cloud.",
    removed: "secret key",
  },
};

export function HomeLabScreen({ onNavigate, kind = "homelab" }: { onNavigate: (tab: Tab) => void; kind?: "homelab" | "cloud" }) {
  const copy = COPY[kind];
  const cloud = kind === "cloud";
  const [allHosts, setHosts] = useState<HomelabHost[] | null>(null);
  const hosts = allHosts?.filter((h) => (h.provider === "aws") === cloud) ?? null;
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
          <h1 className="text-xl font-semibold tracking-tight">{copy.title}</h1>
          <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">{copy.intro}</p>
        </div>
        <Button variant="learn" size="sm" onClick={() => homelabOpenSetup(null, kind).catch((e) => setError(String(e)))}>
          <Plus className="size-3.5" /> {copy.add}
        </Button>
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

      <Panel>
        <PanelHeader title={copy.list} action={hosts && hosts.length > 0 ? <span className="text-[11.5px] text-muted-foreground">{copy.hint}</span> : undefined} />
        {hosts === null ? (
          <div className="flex items-center gap-2 px-3.5 py-4 text-[12.5px] text-muted-foreground"><Spinner className="size-4" /> Loading…</div>
        ) : hosts.length === 0 ? (
          <div className="px-3.5 py-8 text-center">
            {cloud ? <Cloud className="mx-auto size-6 text-muted-foreground/50" /> : <Server className="mx-auto size-6 text-muted-foreground/50" />}
            <p className="mt-2 text-[13px] font-medium">{copy.emptyTitle}</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{copy.emptyBody}</p>
          </div>
        ) : (
          hosts.map((h) => (
            <HostRow
              key={h.id}
              host={h}
              isDefault={h.id === defaultId}
              canDefault={!cloud}
              test={tests[h.id]}
              onTest={() => test(h.id)}
              onEdit={() => homelabOpenSetup(h.id).catch((e) => setError(String(e)))}
              onDefault={() => act(() => homelabSetDefault(h.id === defaultId ? null : h.id))}
              onRemove={() => {
                if (confirm(`Remove ${h.name}? Its ${copy.removed} is deleted from the keychain.`)) act(() => homelabRemove(h.id));
              }}
            />
          ))
        )}
      </Panel>

      <Panel>
        <PanelHeader title="How it works" />
        {cloud ? (
          <>
            <Step n={1} title="Connect your AWS account" body="An IAM user's access keys and a region. The launcher checks them with AWS before saving." />
            <Step n={2} title="Pick AWS on a lab" body="In a lab's Run on choice. Terraform creates one Debian instance in your default VPC, only reachable over SSH from your IP." />
            <Step n={3} title="Attack, then Stop" body="Open shell connects to the attack box next to the lab. Stop destroys the instance, so billing stops with it." />
          </>
        ) : (
          <>
            <Step n={1} title="Connect your host" body="Add the endpoint and an account. The launcher checks it's reachable (and signs in, for Proxmox)." />
            <Step n={2} title="Pick where a lab runs" body="In a lab's Run on choice: this machine or one of your hosts. VM labs launched from the website use the default host." />
            <Step n={3} title="It's built on your server" body="Terraform (Proxmox) or Vagrant (ESXi) creates the lab host there; Stop destroys it." />
          </>
        )}
      </Panel>

      {!cloud && (
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
      )}
    </div>
  );
}

function HostRow({
  host,
  isDefault,
  canDefault,
  test,
  onTest,
  onEdit,
  onDefault,
  onRemove,
}: {
  host: HomelabHost;
  isDefault: boolean;
  canDefault: boolean;
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
            {host.provider === "aws" ? `AWS · ${host.host} · ${host.username.slice(0, 8)}…` : `${KIND[host.provider].label} · ${host.username}@${host.host}:${host.port}`}
            {host.node ? ` · node ${host.node}` : ""}
            {result?.latencyMs != null ? ` · ${result.latencyMs} ms` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={onTest} disabled={test === "testing"}>
            {test === "testing" ? <Spinner className="size-3.5" /> : <Zap className="size-3.5" />} Test
          </Button>
          {canDefault && (
            <IconButton label={isDefault ? "Unset default" : "Make default"} onClick={onDefault}>
              <Star className={cn("size-3.5", isDefault && "fill-current text-learn")} />
            </IconButton>
          )}
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
