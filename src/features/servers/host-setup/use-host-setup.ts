import { useCallback, useEffect, useState } from "react";
import {
  awsCliIdentity,
  awsLogin,
  awsMonthToDateCost,
  awsProfiles,
  azureSubscriptions,
  cloudLogin,
  gcpAccount,
  gcpBillingAccounts,
  gcpOrganizations,
  ociConfig,
  serverSave,
  serverTest,
  type AzureSubscription,
  type CloudProvider,
  type OciConfig,
  type GcpBillingAccount,
  type GcpOrganization,
  type ServerHost,
  type ServerHostInput,
  type ServerTest,
  type RemoteProvider,
  type SystemReport,
} from "@/lib/tauri";
import { CLOUD_DEFAULT_NAME, CLOUD_META, KIND, StepKey } from "@/features/servers/host-setup/constants";

const DEFAULT_NAMES = Object.values(CLOUD_DEFAULT_NAME);
import type { Dependency } from "@/lib/tauri";
import { ignore } from "@/lib/failure";

/** All the server / cloud setup state and actions, shared by the setup steps. */
export function useHostSetup({
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
  const [signingIn, setSigningIn] = useState(false);
  const [signInLog, setSignInLog] = useState<string[] | null>(null);

  const editing = initial.id !== null;
  const aws = v.provider === "aws";
  const azure = v.provider === "azure";
  const gcp = v.provider === "gcp";
  const digitalocean = v.provider === "digitalocean";
  const linode = v.provider === "linode";
  const oci = v.provider === "oci";
  // Token clouds (DigitalOcean, Linode) authenticate with just a pasted API token (no CLI, no username).
  const tokenCloud = digitalocean || linode;
  const cloud = aws || azure || gcp || digitalocean || linode || oci;
  // Azure and GCP authenticate through their CLI (no access keys); the flow is the same shape.
  const cliAuth = azure || gcp;
  // Derived from the saved provider (not separate state) so it stays correct when editing an
  // existing account, where the provider step that would set it is skipped.
  const cloudProvider: CloudProvider = cloud ? (v.provider as CloudProvider) : "aws";
  // AWS can connect through the CLI (a profile / browser sign-in) or with access keys.
  const [profiles, setProfiles] = useState<string[]>([]);
  const [awsIdentity, setAwsIdentity] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState(false);
  const [mtdCost, setMtdCost] = useState<number | null>(null);
  // Azure/GCP: the subscriptions/projects the signed-in account can see, so you pick one
  // instead of typing an id.
  const [azureSubs, setAzureSubs] = useState<AzureSubscription[]>([]);
  const [azureChecking, setAzureChecking] = useState(false);
  const [gcpBilling, setGcpBilling] = useState<GcpBillingAccount[]>([]);
  const [gcpOrgs, setGcpOrgs] = useState<GcpOrganization[]>([]);
  const [gcpEmail, setGcpEmail] = useState<string | null>(null);
  const [gcpChecking, setGcpChecking] = useState(false);
  // OCI: what ~/.oci/config holds, to prefill the compartment (tenancy root) and region.
  const [ociCfg, setOciCfg] = useState<OciConfig | null>(null);
  useEffect(() => {
    if (!oci) {
      setOciCfg(null);
      return;
    }
    ociConfig()
      .then((cfg) => {
        setOciCfg(cfg);
        setV((s) => (s.provider === "oci" ? { ...s, username: s.username || cfg.tenancy, host: cfg.region && !editing ? cfg.region : s.host } : s));
      })
      .catch(() => setOciCfg(null));
  }, [oci, editing]);
  useEffect(() => {
    if (aws) awsProfiles().then(setProfiles).catch(ignore("profiles are a convenience; typed by hand otherwise"));
  }, [aws]);
  const loadAzureSubs = useCallback(() => {
    setAzureChecking(true);
    azureSubscriptions()
      .then((subs) => {
        setAzureSubs(subs);
        // Default to the account's default subscription if none chosen yet.
        setV((s) => (s.provider === "azure" && !s.username && subs.length > 0 ? { ...s, username: (subs.find((x) => x.isDefault) ?? subs[0]).id } : s));
      })
      .catch(() => setAzureSubs([]))
      .finally(() => setAzureChecking(false));
  }, []);
  useEffect(() => {
    if (azure) loadAzureSubs();
    else setAzureSubs([]);
  }, [azure, loadAzureSubs]);
  const loadGcpProjects = useCallback(() => {
    setGcpChecking(true);
    Promise.all([gcpAccount(), gcpBillingAccounts(), gcpOrganizations()])
      .then(([email, billing, orgs]) => {
        setGcpEmail(email);
        setGcpBilling(billing);
        setGcpOrgs(orgs);
        // Default to the first open billing account if none chosen yet.
        const open = billing.find((b) => b.open) ?? billing[0];
        setV((s) => (s.provider === "gcp" && !s.username && open ? { ...s, username: open.id } : s));
      })
      .catch(() => {
        setGcpEmail(null);
        setGcpBilling([]);
        setGcpOrgs([]);
      })
      .finally(() => setGcpChecking(false));
  }, []);
  useEffect(() => {
    if (gcp) loadGcpProjects();
    else {
      setGcpBilling([]);
      setGcpOrgs([]);
    }
  }, [gcp, loadGcpProjects]);
  useEffect(() => {
    // Only meaningful in CLI-credentials mode, where the signed-in profile *is* the account.
    // With pasted access keys these would reflect the machine's default AWS chain (a different
    // account), so don't fetch or show them.
    if (!aws || !v.useCliCreds) {
      setAwsIdentity(null);
      setMtdCost(null);
      return;
    }
    setCheckingId(true);
    awsCliIdentity(v.awsProfile ?? undefined)
      .then(setAwsIdentity)
      .catch(() => setAwsIdentity(null))
      .finally(() => setCheckingId(false));
    awsMonthToDateCost(v.awsProfile ?? undefined)
      .then(setMtdCost)
      .catch(() => setMtdCost(null));
  }, [aws, v.useCliCreds, v.awsProfile]);

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
  // Azure has no access-keys choice (it's CLI-auth), so it skips the "how to connect" step.
  const pickProvider = (id: CloudProvider) => {
    setV((s) => ({
      ...s,
      provider: id as RemoteProvider,
      // The provider's short name, unless the user typed their own.
      name: !s.name.trim() || DEFAULT_NAMES.includes(s.name.trim()) ? CLOUD_DEFAULT_NAME[id] : s.name,
      host:
        id === "azure"
          ? "swedencentral"
          : id === "gcp"
            ? "europe-west1"
            : id === "digitalocean"
              ? "fra1"
              : id === "linode"
                ? "eu-central"
                : id === "oci"
                  ? "eu-frankfurt-1"
                  : "eu-west-3",
      username: "",
      password: null,
      useCliCreds: id === "aws",
      awsProfile: null,
      // node = GCP org id; clear it when switching provider.
      node: null,
      // Budget is AWS-only; don't carry one typed on AWS over to Azure/GCP.
      monthlyLimit: id === "aws" ? s.monthlyLimit : null,
    }));
  };
  const steps: StepKey[] = cloud
    ? editing
      ? aws
        ? ["account", "credentials", "options", "test"]
        : ["credentials", "options", "test"]
      : aws
        ? ["provider", "tools", "account", "credentials", "options", "test"]
        : ["provider", "tools", "credentials", "options", "test"]
    : editing
      ? ["connection", "placement", "test"]
      : ["hypervisor", "tools", "connection", "placement", "test"];
  const key = steps[Math.min(i, steps.length - 1)];

  const set = <K extends keyof ServerHostInput>(k: K, value: ServerHostInput[K]) => setV((s) => ({ ...s, [k]: value }));
  const text = (k: "name" | "host" | "username" | "datastore" | "network" | "node") => ({
    value: (v[k] as string | null) ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
  });

  const connectionOk = tokenCloud
    ? v.host.trim() !== "" && (editing || (v.password ?? "") !== "")
    : cliAuth || oci
      ? v.host.trim() !== "" && v.username.trim() !== ""
      : cloud && v.useCliCreds
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
  // DigitalOcean uses an API token (no CLI); every other cloud has one to install.
  const cloudHasCli = cloud && CLOUD_META[cloudProvider].cli !== "";
  const cloudDep: Dependency = cloudProvider === "azure" ? "azurecli" : cloudProvider === "gcp" ? "gcloud" : "awscli";
  const cloudCliKey = cloudProvider === "gcp" ? "gcloud" : cloudProvider === "azure" ? "azure" : "aws";
  const cloudCliTool = cloudHasCli ? report?.cloudClis[cloudCliKey] : undefined;
  const cloudCliOk = !!cloudCliTool?.installed;
  const toolsOk = cloud
    ? (cloudHasCli ? cloudCliOk : true) && terraformOk
    : v.provider === "vmware_esxi"
      ? vagrantOk && esxiPluginOk && ovftoolOk
      : terraformOk;

  async function runTest(id: string) {
    setTest("testing");
    try {
      setTest(await serverTest(id));
    } catch (e) {
      setTest({ ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e), checks: [] });
    }
  }

  // Save, then move to the Test step and test the saved host.
  async function saveAndTest() {
    setSaving(true);
    setError(null);
    try {
      const fallback = cloud ? (CLOUD_DEFAULT_NAME[v.provider as CloudProvider] ?? v.host.trim()) : v.host.trim();
      const h = await serverSave({ ...v, name: v.name.trim() || fallback });
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
      // Pull the now-available subscriptions / projects so the user can pick one.
      if (cloudProvider === "azure") loadAzureSubs();
      if (cloudProvider === "gcp") loadGcpProjects();
    } catch (e) {
      setSignInLog((x) => [...(x ?? []), `✗ ${String(e)}`]);
    } finally {
      setSigningIn(false);
    }
  }

  // "connected" only once the test says so: a saved host whose test failed isn't.
  const failed = !!test && test !== "testing" && !test.ok;
  const title = saved
    ? failed
      ? `${saved.name} saved, not connected yet`
      : `${saved.name} connected`
    : editing
      ? `Edit ${initial.name}`
      : cloud
        ? "Set up cloud provider"
        : "Connect a host";

  return {
    initial,
    report,
    onRefresh,
    onSaved,
    onDone,
    v,
    setV,
    i,
    setI,
    saving,
    setSaving,
    error,
    setError,
    saved,
    setSaved,
    test,
    setTest,
    pluginLog,
    setPluginLog,
    toolLabel,
    setToolLabel,
    cloudProvider,
    signingIn,
    setSigningIn,
    signInLog,
    setSignInLog,
    editing,
    aws,
    azure,
    gcp,
    digitalocean,
    linode,
    oci,
    ociCfg,
    tokenCloud,
    cliAuth,
    cloud,
    profiles,
    setProfiles,
    awsIdentity,
    setAwsIdentity,
    checkingId,
    setCheckingId,
    mtdCost,
    setMtdCost,
    azureSubs,
    azureChecking,
    gcpBilling,
    gcpOrgs,
    gcpEmail,
    gcpChecking,
    awsSignIn,
    kind,
    status,
    pickProvider,
    steps,
    key,
    set,
    text,
    connectionOk,
    next,
    back,
    toolBusy,
    installTool,
    vagrantOk,
    esxiPluginOk,
    ovftoolOk,
    terraformOk,
    cloudDep,
    cloudHasCli,
    cloudCliTool,
    cloudCliOk,
    toolsOk,
    runTest,
    saveAndTest,
    signIn,
    title,
  };
}

export type HostSetup = ReturnType<typeof useHostSetup>;
