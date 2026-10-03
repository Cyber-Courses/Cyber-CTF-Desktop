"use client";

import { useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, Cloud, ExternalLink, Server, XCircle } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/labs/log-console";
import {
  homelabSave,
  homelabTest,
  installVagrantPlugin,
  type HomelabHost,
  type HomelabHostInput,
  type HomelabTest,
  type RemoteProvider,
  type SystemReport,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

// The home-lab setup flow, shown in its own window (src/app/homelab-setup).

export const KIND: Record<RemoteProvider, { label: string; note: string; port: number; user: string; plugin: string }> = {
  proxmox: { label: "Proxmox VE", note: "Signs in to the Proxmox API", port: 8006, user: "root@pam", plugin: "vagrant-proxmox" },
  vmware_esxi: { label: "VMware ESXi", note: "Drives the host over SSH", port: 22, user: "root", plugin: "vagrant-vmware-esxi" },
  aws: { label: "AWS", note: "EC2 in your own account", port: 443, user: "AKIA…", plugin: "" },
};

/** Home-lab hypervisors, as opposed to cloud accounts. */
export const HOMELAB_KINDS: RemoteProvider[] = ["proxmox", "vmware_esxi"];


export const EMPTY_HOST: HomelabHostInput = {
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
  // Proxmox ships with a self-signed certificate.
  insecureTls: true,
};

/** A new AWS account: region + access keys. */
export const EMPTY_CLOUD: HomelabHostInput = { ...EMPTY_HOST, provider: "aws", insecureTls: false };

/** Proxmox's own logo (official media kit, unaltered), or a neutral mark for ESXi. */
export function HypervisorMark({ provider }: { provider: RemoteProvider }) {
  // AWS logos need Amazon's approval too: a neutral mark.
  if (provider === "aws")
    return (
      <span className="flex h-5 items-center gap-1.5 text-[13px] font-semibold tracking-tight">
        <Cloud className="size-4 text-muted-foreground" /> Amazon Web Services
      </span>
    );
  if (provider === "proxmox")
    // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
    return <img src="/brands/proxmox-full-lockup-inverted-color.svg" alt="Proxmox" className="h-5 w-auto" draggable={false} />;
  // VMware/Broadcom logos need Broadcom's approval, so ESXi gets a neutral mark until then.
  return (
    <span className="flex h-5 items-center gap-1.5 text-[13px] font-semibold tracking-tight">
      <Server className="size-4 text-muted-foreground" /> VMware ESXi
    </span>
  );
}

export function HostSetupPage({
  initial,
  report,
  onRefresh,
  onSaved,
  onDone,
}: {
  initial: HomelabHostInput;
  report: SystemReport | null;
  onRefresh: () => void;
  /** After every save, so the main window's host list can refresh. */
  onSaved: (h: HomelabHost) => void;
  /** Setup finished or cancelled: the window closes. */
  onDone: () => void;
}) {
  const [saved, setSaved] = useState<HomelabHost | null>(null);
  const [draft, setDraft] = useState<HomelabHostInput>(initial);
  const [test, setTest] = useState<HomelabTest | "testing" | null>(null);

  async function runTest(id: string) {
    setTest("testing");
    try {
      setTest(await homelabTest(id));
    } catch (e) {
      setTest({ ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) });
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {draft.id !== null && !saved ? `Edit ${draft.name}` : saved ? `${saved.name} connected` : draft.provider === "aws" ? "Connect AWS" : "Connect a host"}
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {saved
            ? "Saved. Here's what the launcher could check from this machine."
            : draft.provider === "aws"
              ? "Run labs in your own AWS account. The secret key goes to your OS keychain, never to CyberCTF."
              : "Point the launcher at your hypervisor. The password goes to your OS keychain, never to CyberCTF."}
        </p>
      </div>

      {saved ? (
        <Panel>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <HypervisorMark provider={saved.provider} />
            <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">{saved.username}@{saved.host}:{saved.port}</span>
          </div>
          <div className="p-4">
            {test === null || test === "testing" ? (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner className="size-4" /> Testing the connection…</p>
            ) : (
              <p className={cn("flex items-start gap-2 text-[13px]", test.ok ? "text-emerald-500" : "text-rose-400")}>
                {test.ok ? <CheckCircle2 className="mt-px size-4 shrink-0" /> : <XCircle className="mt-px size-4 shrink-0" />}
                <span>
                  {test.message}
                  {test.latencyMs != null && <span className="ml-1.5 font-mono text-[11.5px] text-muted-foreground">{test.latencyMs} ms</span>}
                </span>
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <Button variant="ghost" size="sm" onClick={() => runTest(saved.id)} disabled={test === "testing"}>Test again</Button>
            <Button variant="outline" size="sm" onClick={() => { setDraft({ ...saved, password: null }); setSaved(null); setTest(null); }}>Edit</Button>
            <Button variant="learn" size="sm" onClick={onDone}>Done</Button>
          </div>
        </Panel>
      ) : (
        <HostForm
          key={draft.id ?? "new"}
          initial={draft}
          report={report}
          onRefresh={onRefresh}
          onCancel={onDone}
          onSaved={(h) => {
            setSaved(h);
            onSaved(h);
            runTest(h.id);
          }}
        />
      )}

      <p className="text-[11px] text-muted-foreground/70">
        Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.{" "}
        <button onClick={() => openUrl("https://www.proxmox.com").catch(() => {})} className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
          proxmox.com <ExternalLink className="size-3" />
        </button>{" "}
        VMware and ESXi are trademarks of Broadcom. Amazon Web Services and AWS are trademarks of Amazon.com, Inc. CyberCTF isn&apos;t affiliated with any of them.
      </p>
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
  const cloud = v.provider === "aws";
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
      <PanelHeader title={editing ? "Connection" : cloud ? "AWS account" : "Hypervisor and connection"} />
      <form onSubmit={submit} className="space-y-4 p-4">
        {cloud ? (
          <AwsFields v={v} set={set} text={text} editing={editing} />
        ) : (
        <>
        <div className="grid grid-cols-2 gap-2">
          {HOMELAB_KINDS.map((p) => (
            <button
              key={p}
              type="button"
              disabled={editing}
              onClick={() => setV((s) => ({ ...s, provider: p, port: null }))}
              className={cn(
                "rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-default",
                v.provider === p ? "border-learn/60 bg-learn/5" : "border-border hover:border-ring/60",
                editing && v.provider !== p && "opacity-40",
              )}
            >
              <HypervisorMark provider={p} />
              <p className="mt-2 text-[11.5px] text-muted-foreground">{KIND[p].note}</p>
            </button>
          ))}
        </div>

        {v.provider === "vmware_esxi" && status && !status.pluginInstalled && (
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

        {v.provider === "proxmox" && (
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={v.insecureTls}
              onChange={(e) => set("insecureTls", e.target.checked)}
              className="mt-0.5 size-3.5 accent-[var(--learn)]"
            />
            <span>
              <span className="block text-[12.5px]">Self-signed certificate</span>
              <span className="block text-[11.5px] text-muted-foreground">Proxmox uses one by default. Turn off if your host has a trusted certificate.</span>
            </span>
          </label>
        )}
        </>
        )}

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

function AwsFields({
  v,
  set,
  text,
  editing,
}: {
  v: HomelabHostInput;
  set: <K extends keyof HomelabHostInput>(k: K, value: HomelabHostInput[K]) => void;
  text: (k: "name" | "host" | "username" | "datastore") => { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void };
  editing: boolean;
}) {
  return (
    <>
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-500">
        Labs you start on AWS run in your account and are billed there (about $0.05/hour for the default t3.medium) until you stop them. Stop destroys everything the lab created.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input {...text("name")} placeholder="My AWS" /></Field>
        <Field label="Region"><Input {...text("host")} placeholder="eu-west-3" required /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Access key ID" hint="An IAM user with EC2 access"><Input {...text("username")} placeholder="AKIA…" required /></Field>
        <Field label="Secret access key" hint="Stored in your OS keychain">
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
      <Field label="Instance type" hint="Optional"><Input {...text("datastore")} placeholder="t3.medium" /></Field>
    </>
  );
}
