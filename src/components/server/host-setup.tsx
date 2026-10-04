"use client";

import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, CheckCircle2, ChevronDown, Cloud, ExternalLink, HardDrive, Network, Play, Server, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/labs/log-console";
import { Requirement } from "@/components/machine/setup-steps";
import {
  awsCliIdentity,
  awsLogin,
  awsMonthToDateCost,
  awsProfiles,
  cloudLogin,
  serverSave,
  serverTest,
  installDependency,
  installVagrantPlugin,
  type CloudProvider,
  type ServerHost,
  type ServerHostInput,
  type ServerTest,
  type RemoteProvider,
  type SystemReport,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

// The server setup flow, a step-by-step wizard shown in its own window (src/app/server-setup).
// Matches the "Set up this machine" wizard (components/machine/machine-setup.tsx).

export const KIND: Record<RemoteProvider, { label: string; note: string; port: number; user: string; plugin: string }> = {
  proxmox: { label: "Proxmox VE", note: "Signs in to the Proxmox API", port: 8006, user: "root@pam", plugin: "vagrant-proxmox" },
  vmware_esxi: { label: "VMware ESXi", note: "Drives the host over SSH", port: 22, user: "root", plugin: "vagrant-vmware-esxi" },
  aws: { label: "AWS", note: "EC2 in your own account", port: 443, user: "AKIA…", plugin: "" },
};

/** Server hypervisors, as opposed to cloud accounts. */
export const SERVER_KINDS: RemoteProvider[] = ["proxmox", "vmware_esxi"];

export const EMPTY_HOST: ServerHostInput = {
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
  autoStopHours: null,
};

/** A new AWS account: region + access keys. */
export const EMPTY_CLOUD: ServerHostInput = { ...EMPTY_HOST, provider: "aws", host: "eu-west-3", useCliCreds: true, insecureTls: false, autoStopHours: 4 };

/** Common AWS regions for the cloud setup dropdown (code, human name). */
const AWS_REGIONS: [string, string][] = [
  ["us-east-1", "US East (N. Virginia)"],
  ["us-east-2", "US East (Ohio)"],
  ["us-west-2", "US West (Oregon)"],
  ["eu-west-1", "Europe (Ireland)"],
  ["eu-west-3", "Europe (Paris)"],
  ["eu-central-1", "Europe (Frankfurt)"],
  ["ap-southeast-1", "Asia Pacific (Singapore)"],
  ["ap-northeast-1", "Asia Pacific (Tokyo)"],
];

/** Proxmox's own logo (official media kit, unaltered), or a neutral mark for ESXi / AWS. */
export function HypervisorMark({ provider }: { provider: RemoteProvider }) {
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

type StepKey = "provider" | "hypervisor" | "tools" | "connection" | "placement" | "account" | "credentials" | "options" | "connect" | "test";
/** Cloud providers offered in the cloud setup. AWS is the supported target; Azure and GCP
 *  connect via their CLI's own sign-in (no lab provisioning yet). */
const CLOUD_META: Record<CloudProvider, { label: string; cli: string; color: string; ready: boolean }> = {
  aws: { label: "Amazon Web Services", cli: "aws", color: "#ff9900", ready: true },
  azure: { label: "Microsoft Azure", cli: "az", color: "#3b8eea", ready: false },
  gcp: { label: "Google Cloud", cli: "gcloud", color: "#34a853", ready: false },
};

/** The provider picker. Only AWS is a real target today; the rest are coming soon.
 *  `logo` marks the ones with an SVG in public/brands (others fall back to a cloud icon). */
const CLOUD_PICKER: { id: string; label: string; ready: boolean; logo: boolean }[] = [
  { id: "aws", label: "Amazon Web Services", ready: true, logo: true },
  { id: "azure", label: "Microsoft Azure", ready: false, logo: true },
  { id: "gcp", label: "Google Cloud", ready: false, logo: true },
  { id: "digitalocean", label: "DigitalOcean", ready: false, logo: false },
  { id: "hetzner", label: "Hetzner", ready: false, logo: false },
];

export function HostSetupPage({
  initial,
  report,
  onRefresh,
  onSaved,
  onDone,
}: {
  initial: ServerHostInput;
  report: SystemReport | null;
  onRefresh: () => void;
  /** After every save, so the main window's host list can refresh. */
  onSaved: (h: ServerHost) => void;
  /** Setup finished or cancelled: the window closes. */
  onDone: () => void;
}) {
  const [v, setV] = useState<ServerHostInput>(initial);
  const [i, setI] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ServerHost | null>(null);
  const [test, setTest] = useState<ServerTest | "testing" | null>(null);
  const [pluginLog, setPluginLog] = useState<string[] | null>(null);
  const [toolLabel, setToolLabel] = useState("Install");
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>("aws");
  const [signingIn, setSigningIn] = useState(false);
  const [signInLog, setSignInLog] = useState<string[] | null>(null);

  const editing = initial.id !== null;
  const cloud = v.provider === "aws";
  // AWS can connect through the CLI (a profile / browser sign-in) or with access keys.
  const [profiles, setProfiles] = useState<string[]>([]);
  const [awsIdentity, setAwsIdentity] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState(false);
  const [mtdCost, setMtdCost] = useState<number | null>(null);
  useEffect(() => {
    if (cloud) awsProfiles().then(setProfiles).catch(() => {});
  }, [cloud]);
  useEffect(() => {
    if (!cloud) return;
    setCheckingId(true);
    awsCliIdentity(v.awsProfile ?? undefined)
      .then(setAwsIdentity)
      .catch(() => setAwsIdentity(null))
      .finally(() => setCheckingId(false));
    awsMonthToDateCost(v.awsProfile ?? undefined).then(setMtdCost).catch(() => setMtdCost(null));
  }, [cloud, v.awsProfile]);

  async function awsSignIn() {
    setSigningIn(true);
    setSignInLog(["Signing in to AWS…"]);
    try {
      await awsLogin(v.awsProfile ?? null, (l) => setSignInLog((x) => [...(x ?? []), l]));
      const id = await awsCliIdentity(v.awsProfile ?? undefined);
      setAwsIdentity(id);
      setSignInLog((x) => [...(x ?? []), id ? `✓ Signed in as ${id}` : "✗ Not signed in"]);
    } catch (e) {
      setSignInLog((x) => [...(x ?? []), `✗ ${String(e)}`]);
    } finally {
      setSigningIn(false);
    }
  }
  const kind = KIND[v.provider];
  const status = report?.vmProviders.find((p) => p.provider === v.provider);

  // The ordered steps for this setup. Editing skips the hypervisor choice.
  const steps: StepKey[] = cloud
    ? editing
      ? ["account", "credentials", "options", "test"]
      : ["provider", "tools", "account", "credentials", "options", "test"]
    : editing
      ? ["connection", "placement", "test"]
      : ["hypervisor", "tools", "connection", "placement", "test"];
  const key = steps[Math.min(i, steps.length - 1)];

  const set = <K extends keyof ServerHostInput>(k: K, value: ServerHostInput[K]) => setV((s) => ({ ...s, [k]: value }));
  const text = (k: "name" | "host" | "username" | "datastore" | "network" | "node") => ({
    value: (v[k] as string | null) ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
  });

  const connectionOk =
    cloud && v.useCliCreds
      ? v.host.trim() !== ""
      : v.host.trim() !== "" && v.username.trim() !== "" && (editing || (v.password ?? "") !== "");
  const next = () => setI((n) => Math.min(n + 1, steps.length - 1));
  const back = () => setI((n) => Math.max(n - 1, 0));

  // Installs one of the tools this server type needs on this machine, logging below.
  const toolBusy = pluginLog !== null && !pluginLog.at(-1)?.match(/^[✓✗]/);
  async function installTool(label: string, run: (onLog: (l: string) => void) => Promise<void>) {
    setToolLabel(label);
    setPluginLog([`Installing ${label}…`]);
    try {
      await run((l) => setPluginLog((x) => [...(x ?? []), l]));
      setPluginLog((x) => [...(x ?? []), "✓ Installed"]);
    } catch (e) {
      setPluginLog((x) => [...(x ?? []), `✗ ${String(e)}`]);
    } finally {
      onRefresh();
    }
  }

  // What this machine needs to drive the chosen server: ESXi goes through Vagrant, its ESXi
  // plugin and VMware's OVF Tool; Proxmox through Terraform (installed locally).
  const vagrantOk = !!report?.vagrant.installed;
  const esxiPluginOk = !!status?.pluginInstalled;
  const ovftoolOk = !!report?.ovftool?.installed;
  const terraformOk = !!report?.terraform.installed;
  const cloudDep = cloudProvider === "aws" ? "awscli" : cloudProvider === "azure" ? "azurecli" : "gcloud";
  const cloudCliTool = report?.cloudClis[cloudProvider === "gcp" ? "gcloud" : cloudProvider];
  const cloudCliOk = !!cloudCliTool?.installed;
  const toolsOk = cloud ? cloudCliOk && terraformOk : v.provider === "vmware_esxi" ? vagrantOk && esxiPluginOk && ovftoolOk : terraformOk;

  async function runTest(id: string) {
    setTest("testing");
    try {
      setTest(await serverTest(id));
    } catch (e) {
      setTest({ ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) });
    }
  }

  // Save, then move to the Test step and test the saved host.
  async function saveAndTest() {
    setSaving(true);
    setError(null);
    try {
      const h = await serverSave({ ...v, name: v.name.trim() || v.host.trim() });
      setSaved(h);
      onSaved(h);
      next();
      runTest(h.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function signIn() {
    setSigningIn(true);
    setSignInLog([`Signing in to ${CLOUD_META[cloudProvider].label}…`]);
    try {
      await cloudLogin(cloudProvider, (l) => setSignInLog((x) => [...(x ?? []), l]));
      setSignInLog((x) => [...(x ?? []), "✓ Signed in"]);
    } catch (e) {
      setSignInLog((x) => [...(x ?? []), `✗ ${String(e)}`]);
    } finally {
      setSigningIn(false);
    }
  }

  const title = saved ? `${saved.name} connected` : editing ? `Edit ${initial.name}` : cloud ? "Set up cloud provider" : "Connect a host";

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {cloud
            ? "Run labs as throwaway instances in your own cloud account. Credentials stay on this machine, never with Cyber CTF."
            : "Point the launcher at your server. The password goes to your OS keychain, never to Cyber CTF."}
        </p>
      </div>

      {/* Segmented progress, one bar per step. */}
      <div className="mt-5 flex gap-1.5">
        {steps.map((s, n) => (
          <div key={s} className={cn("h-1 flex-1 rounded-full transition-colors", n <= i ? "bg-learn" : "bg-muted")} />
        ))}
      </div>

      <div key={key} className="mt-7 animate-rise-in">
        <p className="text-[11.5px] font-medium tabular-nums text-muted-foreground">Step {i + 1} of {steps.length}</p>
        {key === "hypervisor" && (
          <Step icon={Server} title="Choose your hypervisor" description="Where the launcher will create and run VM labs.">
            <div className="grid grid-cols-2 gap-2.5">
              {SERVER_KINDS.map((p) => {
                const selected = v.provider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setV((s) => ({ ...s, provider: p, port: null }))}
                    className={cn(
                      "relative rounded-xl border p-4 text-left transition-colors",
                      selected ? "border-learn bg-learn/5 ring-1 ring-learn/40" : "border-border hover:border-ring/60",
                    )}
                  >
                    <span className={cn("absolute right-3 top-3 grid size-4 place-items-center rounded-full border transition-colors", selected ? "border-learn bg-learn text-white" : "border-muted-foreground/30")}>
                      {selected && <CheckCircle2 className="size-3" />}
                    </span>
                    <HypervisorMark provider={p} />
                    <p className="mt-2 text-[11.5px] text-muted-foreground">{KIND[p].note}</p>
                  </button>
                );
              })}
            </div>
            <Nav right={<Button variant="learn" onClick={next}>Continue</Button>} />
          </Step>
        )}

        {key === "tools" && (
          <Step
            icon={HardDrive}
            title={cloud ? "Command-line tool" : "Tools on this machine"}
            description={cloud ? `The ${CLOUD_META[cloudProvider].label} CLI, used to connect and provision.` : `What the launcher needs here to run labs on ${KIND[v.provider].label}.`}
          >
            <div className="overflow-hidden rounded-lg border border-border">
              {!report ? (
                <div className="flex items-center gap-2 px-3.5 py-3 text-[12.5px] text-muted-foreground"><Spinner className="size-4" /> Checking this machine…</div>
              ) : cloud ? (
                <>
                  <Requirement
                    ok={cloudCliOk}
                    title={`${CLOUD_META[cloudProvider].label} CLI`}
                    detail={cloudCliOk ? (cloudCliTool?.version ?? "Installed") : `The ${CLOUD_META[cloudProvider].cli} CLI, needed to connect and provision.`}
                    action={<Button variant="learn" size="sm" disabled={toolBusy} onClick={() => installTool(`${CLOUD_META[cloudProvider].cli} CLI`, (log) => installDependency(cloudDep, log))}>Install {CLOUD_META[cloudProvider].cli}</Button>}
                  />
                  <Requirement
                    ok={terraformOk}
                    title="Terraform"
                    detail={terraformOk ? (report?.terraform.version ?? "Installed") : "Creates and destroys the cloud lab. Its provider plugins are fetched automatically on first run."}
                    action={<Button variant="learn" size="sm" disabled={toolBusy} onClick={() => installTool("Terraform", (log) => installDependency("terraform", log))}>Install Terraform</Button>}
                  />
                </>
              ) : v.provider === "vmware_esxi" ? (
                <>
                  <Requirement
                    ok={vagrantOk}
                    title="Vagrant"
                    detail={vagrantOk ? (report?.vagrant.version ?? "Installed") : "Builds and runs the lab VMs on the host."}
                    action={<Button variant="learn" size="sm" disabled={toolBusy} onClick={() => installTool("Vagrant", (log) => installDependency("vagrant", log))}>Install Vagrant</Button>}
                  />
                  <Requirement
                    ok={esxiPluginOk}
                    title="Vagrant plugin for ESXi"
                    detail={vagrantOk || esxiPluginOk ? kind.plugin : `${kind.plugin}, once Vagrant is installed.`}
                    action={<Button variant="learn" size="sm" disabled={toolBusy || !vagrantOk} onClick={() => installTool(kind.plugin, (log) => installVagrantPlugin(kind.plugin, log))}>Install plugin</Button>}
                  />
                  <Requirement
                    ok={ovftoolOk}
                    title="VMware OVF Tool"
                    detail={ovftoolOk ? (report?.ovftool.version ?? "Installed") : "Uploads the lab VMs to ESXi. Comes with VMware Fusion / Workstation, or standalone from Broadcom (free account)."}
                    action={
                      <Button variant="outline" size="sm" onClick={() => openUrl("https://developer.broadcom.com/tools/open-virtualization-format-ovf-tool/latest").catch(() => {})}>
                        <ExternalLink className="size-3.5" /> Get
                      </Button>
                    }
                  />
                </>
              ) : (
                <Requirement
                  ok={terraformOk}
                  title="Terraform"
                  detail={report?.terraform.installed ? (report.terraform.version ?? "Installed") : "Drives the Proxmox API. Install it to run Proxmox labs."}
                  action={<Button variant="learn" size="sm" disabled={toolBusy} onClick={() => installTool("Terraform", (log) => installDependency("terraform", log))}>Install Terraform</Button>}
                />
              )}
            </div>
            {pluginLog && <div className="mt-3"><LogConsole lines={pluginLog} running={toolBusy} title={`Install ${toolLabel}`} /></div>}
            <Nav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={
                <span className="flex gap-2">
                  {!toolsOk && <Button variant="outline" onClick={() => onRefresh()}>Re-check</Button>}
                  <Button variant="learn" onClick={next} disabled={!toolsOk}>Continue</Button>
                </span>
              }
            />
          </Step>
        )}

        {key === "connection" && (
          <Step
            icon={Network}
            title={`Connect to ${KIND[v.provider].label}`}
            description={v.provider === "proxmox" ? "The launcher signs in to the Proxmox API." : "The launcher drives the host over SSH."}
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_110px]">
              <Field label="Name"><Input {...text("name")} placeholder={v.provider === "proxmox" ? "Garage Proxmox" : "ESXi box"} /></Field>
              <Field label="Host"><Input {...text("host")} placeholder="192.168.1.20 or pve.lan" /></Field>
              <Field label={v.provider === "proxmox" ? "API port" : "SSH port"}>
                <Input type="number" min={1} max={65535} value={v.port ?? ""} onChange={(e) => set("port", e.target.value ? Number(e.target.value) : null)} placeholder={String(kind.port)} />
              </Field>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Username" hint={v.provider === "proxmox" ? "With realm, e.g. root@pam" : undefined}>
                <Input {...text("username")} placeholder={kind.user} />
              </Field>
              <Field label="Password" hint="Stored in your OS keychain">
                <Input type="password" value={v.password ?? ""} onChange={(e) => set("password", e.target.value || null)} placeholder={editing ? "Unchanged" : ""} autoComplete="off" />
              </Field>
            </div>
            <Nav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={<Button variant="learn" onClick={next} disabled={!connectionOk}>Continue</Button>}
            />
          </Step>
        )}

        {key === "placement" && (
          <Step icon={HardDrive} title="Placement" description="Where labs are placed on the host. Leave blank for the host's defaults.">
            <div className={cn("grid gap-3", v.provider === "proxmox" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
              {v.provider === "proxmox" && <Field label="Node" hint="Optional"><Input {...text("node")} placeholder="pve" /></Field>}
              <Field label={v.provider === "proxmox" ? "Storage" : "Datastore"} hint="Optional"><Input {...text("datastore")} placeholder={v.provider === "proxmox" ? "local-lvm" : "datastore1"} /></Field>
              <Field label={v.provider === "proxmox" ? "Bridge" : "Port group"} hint="Optional"><Input {...text("network")} placeholder={v.provider === "proxmox" ? "vmbr0" : "VM Network"} /></Field>
            </div>
            {v.provider === "proxmox" && (
              <label className="mt-4 flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={v.insecureTls} onChange={(e) => set("insecureTls", e.target.checked)} className="mt-0.5 size-3.5 accent-[var(--learn)]" />
                <span>
                  <span className="block text-[12.5px]">Self-signed certificate</span>
                  <span className="block text-[11.5px] text-muted-foreground">Proxmox uses one by default. Turn off if your host has a trusted certificate.</span>
                </span>
              </label>
            )}
            {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}
            <Nav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={<Button variant="learn" onClick={saveAndTest} disabled={saving}>{saving && <Spinner className="size-4" />} Save and test</Button>}
            />
          </Step>
        )}

        {key === "account" && (
          <Step icon={Cloud} title="How to connect" description="Choose how the launcher signs in to AWS.">
            <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-500">
              Labs run in your account and are billed while they run; the cost depends on each lab&apos;s size. Stopping a lab, or its auto-stop, destroys what it created.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => set("useCliCreds", true)} className={cn("rounded-lg border p-3 text-left transition-colors", v.useCliCreds ? "border-learn bg-learn/5 ring-1 ring-learn/40" : "border-border hover:border-ring/60")}>
                <span className="block text-[12.5px] font-medium">Use the AWS CLI</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">A profile or browser sign-in. No secret stored.</span>
              </button>
              <button type="button" onClick={() => set("useCliCreds", false)} className={cn("rounded-lg border p-3 text-left transition-colors", !v.useCliCreds ? "border-learn bg-learn/5 ring-1 ring-learn/40" : "border-border hover:border-ring/60")}>
                <span className="block text-[12.5px] font-medium">Access keys</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">An IAM user&apos;s key and secret.</span>
              </button>
            </div>
            <Nav
              left={i > 0 ? <Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button> : <Button variant="ghost" onClick={onDone}>Cancel</Button>}
              right={<Button variant="learn" onClick={next}>Continue</Button>}
            />
          </Step>
        )}

        {key === "credentials" && (
          <Step icon={Cloud} title={v.useCliCreds ? "AWS CLI" : "Access keys"} description={v.useCliCreds ? "Pick a profile, or sign in with the browser." : "An IAM user's access keys."}>
            {v.useCliCreds ? (
              <div className="space-y-3">
                {profiles.length > 0 && (
                  <Field label="Profile">
                    <Select value={v.awsProfile ?? ""} onChange={(e) => set("awsProfile", e.target.value || null)}>
                      <option value="">default</option>
                      {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
                    </Select>
                  </Field>
                )}
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[12px]">
                  {checkingId ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground"><Spinner className="size-3.5" /> Checking…</span>
                  ) : awsIdentity ? (
                    <span className="flex items-center gap-1.5 text-emerald-500"><CheckCircle2 className="size-3.5" /> Signed in as {awsIdentity}</span>
                  ) : (
                    <span className="text-muted-foreground">Not signed in on this profile.</span>
                  )}
                  <Button variant="outline" size="sm" className="ml-auto" onClick={awsSignIn} disabled={signingIn}>
                    {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (browser)
                  </Button>
                </div>
                {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" />}
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Access key ID" hint="An IAM user with EC2 access"><Input {...text("username")} placeholder="AKIA…" /></Field>
                  <Field label="Secret access key" hint="Stored in your OS keychain">
                    <Input type="password" value={v.password ?? ""} onChange={(e) => set("password", e.target.value || null)} placeholder={editing ? "Unchanged" : ""} autoComplete="off" />
                  </Field>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  No keys yet?{" "}
                  <button type="button" onClick={() => openUrl("https://console.aws.amazon.com/iam/home#/security_credentials").catch(() => {})} className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
                    Create them in the AWS console <ExternalLink className="size-3" />
                  </button>
                </p>
              </>
            )}
            <div className="mt-3">
              <Field label="Region">
                <Select value={v.host} onChange={(e) => set("host", e.target.value)}>
                  {v.host && !AWS_REGIONS.some(([code]) => code === v.host) && <option value={v.host}>{v.host}</option>}
                  {AWS_REGIONS.map(([code, name]) => <option key={code} value={code}>{code} — {name}</option>)}
                </Select>
              </Field>
            </div>
            {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}
            <Nav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={<Button variant="learn" onClick={next} disabled={!connectionOk}>Continue</Button>}
            />
          </Step>
        )}

        {key === "options" && (
          <Step icon={Cloud} title="Lab settings" description="Name this account and choose when idle labs stop.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name"><Input {...text("name")} placeholder="My AWS" /></Field>
              <Field label="Auto-stop">
                <Select value={String(v.autoStopHours ?? 4)} onChange={(e) => set("autoStopHours", Number(e.target.value))}>
                  {[1, 2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hour{h > 1 ? "s" : ""}</option>)}
                  <option value={0}>Never</option>
                </Select>
              </Field>
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              An auto-stopped lab terminates itself when the time is up, even if this machine is off. Each lab picks its own instance size, so the cost depends on the lab.
            </p>
            <div className="mt-3">
              <Field label="Monthly budget (USD)" hint="optional">
                <Input type="number" min={0} step={5} value={v.monthlyLimit ?? ""} onChange={(e) => set("monthlyLimit", e.target.value === "" ? null : Number(e.target.value))} placeholder="no limit" />
              </Field>
              {mtdCost != null && (
                <p className={cn("mt-1.5 text-[11.5px]", v.monthlyLimit && mtdCost >= v.monthlyLimit ? "text-rose-400" : "text-muted-foreground")}>
                  Spent this month: ${mtdCost.toFixed(2)}{v.monthlyLimit ? ` of $${v.monthlyLimit.toFixed(2)}` : ""}.
                </p>
              )}
            </div>
            {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}
            <Nav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={<Button variant="learn" onClick={saveAndTest} disabled={saving || !connectionOk}>{saving && <Spinner className="size-4" />} Save and test</Button>}
            />
          </Step>
        )}

        {key === "provider" && (
          <Step icon={Cloud} title="Choose a cloud provider" description="Where labs run as throwaway instances in your own account. AWS today; more coming.">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {CLOUD_PICKER.map((p) => {
                const selected = p.ready && cloudProvider === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!p.ready}
                    onClick={() => p.ready && setCloudProvider(p.id as CloudProvider)}
                    className={cn(
                      "relative rounded-xl border p-4 text-left transition-colors",
                      !p.ready
                        ? "cursor-default border-border opacity-55"
                        : selected
                          ? "border-learn bg-learn/5 ring-1 ring-learn/40"
                          : "border-border hover:border-ring/60",
                    )}
                  >
                    {p.ready && (
                      <span className={cn("absolute right-3 top-3 grid size-4 place-items-center rounded-full border transition-colors", selected ? "border-learn bg-learn text-white" : "border-muted-foreground/30")}>
                        {selected && <CheckCircle2 className="size-3" />}
                      </span>
                    )}
                    {p.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
                      <img src={`/brands/${p.id}.svg`} alt="" className="size-6" draggable={false} />
                    ) : (
                      <Cloud className="size-6 text-muted-foreground" />
                    )}
                    <p className="mt-2 text-[12.5px] font-medium">{p.label}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{p.ready ? "Available" : "Coming soon"}</p>
                  </button>
                );
              })}
            </div>
            <Nav left={<Button variant="ghost" onClick={onDone}>Cancel</Button>} right={<Button variant="learn" onClick={next} disabled={!CLOUD_META[cloudProvider]?.ready}>Continue</Button>} />
          </Step>
        )}

        {key === "connect" && (
          <Step icon={Cloud} title={`Connect ${CLOUD_META[cloudProvider].label}`} description="Sign in with the provider's CLI. Nothing is stored by Cyber CTF; Terraform uses the CLI's credentials.">
            <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-500">
              Lab provisioning for {CLOUD_META[cloudProvider].label} is coming. Sign in now so the CLI is ready; AWS is the supported target today.
            </p>
            {report?.cloudClis[cloudProvider === "gcp" ? "gcloud" : cloudProvider]?.installed ? (
              <>
                <Button variant="learn" onClick={signIn} disabled={signingIn}>
                  {signingIn && <Spinner className="size-4" />} Sign in with {CLOUD_META[cloudProvider].cli}
                </Button>
                {signInLog && <div className="mt-3"><LogConsole lines={signInLog} running={signingIn} title="Sign in" /></div>}
              </>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">The {CLOUD_META[cloudProvider].cli} CLI isn&apos;t installed. Install it from the Cloud page first, then come back.</p>
            )}
            <Nav
              left={<Button variant="outline" onClick={back}><ArrowLeft className="size-4" /> Back</Button>}
              right={<Button variant="learn" onClick={onDone}>Done</Button>}
            />
          </Step>
        )}

        {key === "test" && (
          <Step icon={CheckCircle2} title="Connection test" description="Saved. Here's what the launcher could check from this machine.">
            {test === null || test === "testing" ? (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner className="size-4" /> Testing the connection…</p>
            ) : (
              <div className={cn("flex items-start gap-3 rounded-lg border p-3.5", test.ok ? "border-emerald-500/25 bg-emerald-500/10" : "border-rose-500/25 bg-rose-500/10")}>
                {test.ok ? <CheckCircle2 className="mt-px size-5 shrink-0 text-emerald-500" /> : <XCircle className="mt-px size-5 shrink-0 text-rose-400" />}
                <p className={cn("text-[13px]", test.ok ? "text-foreground" : "text-rose-300")}>
                  {test.message}
                  {test.latencyMs != null && <span className="ml-1.5 font-mono text-[11.5px] text-muted-foreground">{test.latencyMs} ms</span>}
                </p>
              </div>
            )}
            <Nav
              left={<Button variant="outline" onClick={() => saved && runTest(saved.id)} disabled={test === "testing"}>Test again</Button>}
              right={<Button variant="learn" onClick={onDone}><Play className="size-4" /> Done</Button>}
            />
          </Step>
        )}
      </div>
    </>
  );
}

/** Trademark line, shown pinned at the bottom of the setup window. */
export function SetupTrademarks({ cloud = false }: { cloud?: boolean }) {
  if (cloud) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        Amazon Web Services and AWS are trademarks of Amazon.com, Inc. Microsoft Azure and Google Cloud are trademarks of their respective owners. Cyber CTF isn&apos;t affiliated with any of them.
      </p>
    );
  }
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground/70">
      Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.{" "}
      <button onClick={() => openUrl("https://www.proxmox.com").catch(() => {})} className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
        proxmox.com <ExternalLink className="size-3" />
      </button>{" "}
      VMware and ESXi are trademarks of Broadcom. Cyber CTF isn&apos;t affiliated with any of them.
    </p>
  );
}

function Step({ icon: Icon, title, description, children }: { icon: typeof Server; title: string; description: string; children: ReactNode }) {
  return (
    // mt-2 separates the icon row from the "Step N of M" line above it, as in machine-setup.
    <div className="mt-2">
      <div className="flex items-start gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
          <Icon className="size-5 text-foreground" />
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Nav({ left, right }: { left?: ReactNode; right: ReactNode }) {
  return (
    <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
      <div>{left}</div>
      <div>{right}</div>
    </div>
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

function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          "w-full cursor-pointer appearance-none rounded-md border border-border bg-card px-3 py-2 pr-9 text-[13px] text-foreground outline-none transition-colors hover:border-ring/60 focus:border-ring",
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
