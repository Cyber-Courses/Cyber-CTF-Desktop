"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, Pencil, Plus, Server, Star, Trash2, XCircle, Zap } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/labs/log-console";
import {
  homelabList,
  homelabRemove,
  homelabSave,
  homelabSetDefault,
  homelabTest,
  installVagrantPlugin,
  type HomelabHost,
  type HomelabHostInput,
  type HomelabTest,
  type RemoteProvider,
  type SystemReport,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "setup";

const KIND: Record<RemoteProvider, { label: string; note: string; port: number; user: string; plugin: string }> = {
  proxmox: { label: "Proxmox VE", note: "Signs in to the Proxmox API", port: 8006, user: "root@pam", plugin: "vagrant-proxmox" },
  vmware_esxi: { label: "VMware ESXi", note: "Drives the host over SSH", port: 22, user: "root", plugin: "vagrant-vmware-esxi" },
};

const EMPTY: HomelabHostInput = {
  id: null,
  name: "",
  provider: "proxmox",
  host: "",
  port: null,
  username: "",
  password: null,
  datastore: null,
  network: null,
  node: null,
};

export function HomeLabScreen({
  report,
  onRefresh,
  onNavigate,
}: {
  report: SystemReport | null;
  onRefresh: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  const [hosts, setHosts] = useState<HomelabHost[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<HomelabHostInput | null>(null);
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
        {!form && (
          <Button variant="learn" size="sm" onClick={() => setForm({ ...EMPTY })}>
            <Plus className="size-3.5" /> Add host
          </Button>
        )}
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

      {form && (
        <HostForm
          initial={form}
          report={report}
          onRefresh={onRefresh}
          onCancel={() => setForm(null)}
          onSaved={(h) => {
            setForm(null);
            reload();
            test(h.id);
          }}
        />
      )}

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
              onEdit={() => setForm({ ...h, password: null })}
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

function HostForm({
  initial,
  report,
  onRefresh,
  onCancel,
  onSaved,
}: {
  initial: HomelabHostInput;
  report: SystemReport | null;
  onRefresh: () => void;
  onCancel: () => void;
  onSaved: (h: HomelabHost) => void;
}) {
  const [v, setV] = useState<HomelabHostInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginLog, setPluginLog] = useState<string[] | null>(null);
  const editing = initial.id !== null;
  const kind = KIND[v.provider];
  const status = report?.vmProviders.find((p) => p.provider === v.provider);
  const set = <K extends keyof HomelabHostInput>(k: K, value: HomelabHostInput[K]) => setV((s) => ({ ...s, [k]: value }));
  const text = (k: "name" | "host" | "username" | "datastore" | "network" | "node") => ({
    value: (v[k] as string | null) ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
  });

  async function installPlugin() {
    setPluginLog([`Installing ${kind.plugin}…`]);
    try {
      await installVagrantPlugin(kind.plugin, (l) => setPluginLog((x) => [...(x ?? []), l]));
      setPluginLog((x) => [...(x ?? []), "✓ Installed"]);
    } catch (e) {
      setPluginLog((x) => [...(x ?? []), `✗ ${String(e)}`]);
    } finally {
      onRefresh();
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await homelabSave({ ...v, name: v.name.trim() || v.host.trim() }));
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel>
      <PanelHeader title={editing ? `Edit ${initial.name}` : "Add a host"} />
      <form onSubmit={submit} className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(KIND) as RemoteProvider[]).map((p) => (
            <button
              key={p}
              type="button"
              disabled={editing}
              onClick={() => setV((s) => ({ ...s, provider: p, port: null }))}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-default",
                v.provider === p ? "border-learn/60 bg-learn/5" : "border-border hover:border-ring/60",
                editing && v.provider !== p && "opacity-40",
              )}
            >
              <p className="text-[13px] font-medium">{KIND[p].label}</p>
              <p className="text-[11.5px] text-muted-foreground">{KIND[p].note}</p>
            </button>
          ))}
        </div>

        {status && !status.pluginInstalled && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-[12px] text-amber-500">
                {status.reason ?? `Needs the Vagrant plugin ${kind.plugin}.`}
              </p>
              {report?.vagrant.installed && (
                <Button type="button" variant="outline" size="sm" onClick={installPlugin} disabled={pluginLog !== null && !pluginLog.at(-1)?.match(/^[✓✗]/)}>
                  Install {kind.plugin}
                </Button>
              )}
            </div>
            {pluginLog && <div className="mt-2"><LogConsole lines={pluginLog} /></div>}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_110px]">
          <Field label="Name"><Input {...text("name")} placeholder={v.provider === "proxmox" ? "Garage Proxmox" : "ESXi box"} /></Field>
          <Field label="Host"><Input {...text("host")} placeholder="192.168.1.20 or pve.lan" required /></Field>
          <Field label={v.provider === "proxmox" ? "API port" : "SSH port"}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={v.port ?? ""}
              onChange={(e) => set("port", e.target.value ? Number(e.target.value) : null)}
              placeholder={String(kind.port)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Username" hint={v.provider === "proxmox" ? "Include the realm, e.g. root@pam" : undefined}>
            <Input {...text("username")} placeholder={kind.user} required />
          </Field>
          <Field label="Password" hint="Stored in your OS keychain">
            <Input
              type="password"
              value={v.password ?? ""}
              onChange={(e) => set("password", e.target.value || null)}
              placeholder={editing ? "Unchanged" : ""}
              required={!editing}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className={cn("grid gap-3", v.provider === "proxmox" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          {v.provider === "proxmox" && <Field label="Node" hint="Optional"><Input {...text("node")} placeholder="pve" /></Field>}
          <Field label={v.provider === "proxmox" ? "Storage" : "Datastore"} hint="Optional">
            <Input {...text("datastore")} placeholder={v.provider === "proxmox" ? "local-lvm" : "datastore1"} />
          </Field>
          <Field label={v.provider === "proxmox" ? "Bridge" : "Port group"} hint="Optional">
            <Input {...text("network")} placeholder={v.provider === "proxmox" ? "vmbr0" : "VM Network"} />
          </Field>
        </div>

        {error && <p className="text-[12px] text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="learn" size="sm" disabled={saving}>
            {saving && <Spinner className="size-3.5" />} {editing ? "Save" : "Add and test"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline gap-2 text-[12px] text-muted-foreground">
        {label}
        {hint && <span className="text-[11px] text-muted-foreground/60">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      spellCheck={false}
      {...props}
      className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring"
    />
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
