"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, ChevronDown, Pencil, Plus, Square, Trash2, X, XCircle, Zap } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLabs, type Lab } from "@/lib/use-labs";
import {
  awsMonthToDateCost,
  cloudLogin,
  installDependency,
  labStop,
  provisioningImages,
  provisioningPull,
  SERVER_CHANGED,
  serverList,
  serverOpenSetup,
  serverRemove,
  serverTest,
  systemCheck,
  type CloudProvider,
  type Dependency,
  type ProvisioningImage,
  type ServerHost,
  type ServerTest,
  type SystemReport,
  type Tool,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The Cloud page: connect a cloud account (AWS today) and run labs as throwaway instances
 *  in it. Kept separate from the Server page so each evolves on its own. */
export function CloudScreen() {
  const [allHosts, setHosts] = useState<ServerHost[] | null>(null);
  const hosts = allHosts?.filter((h) => h.provider === "aws") ?? null;
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ServerTest | "testing">>({});
  const [report, setReport] = useState<SystemReport | null>(null);
  const [provImages, setProvImages] = useState<ProvisioningImage[] | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [pullBusy, setPullBusy] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState<boolean | null>(null);
  const [spend, setSpend] = useState<Record<string, number | null>>({});
  const { labs, statuses, refreshStatus } = useLabs();
  const [stopping, setStopping] = useState<string | null>(null);

  const reload = useCallback(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    systemCheck().then(setReport).catch(() => {});
    provisioningImages().then(setProvImages).catch(() => {});
  }, []);
  // The setup window saves accounts; refresh when it says so.
  useEffect(() => {
    const off = listen(SERVER_CHANGED, reload);
    return () => {
      off.then((f) => f()).catch(() => {});
    };
  }, [reload]);
  // Month-to-date spend, only for accounts that set a budget (Cost Explorer costs per call).
  useEffect(() => {
    (allHosts ?? [])
      .filter((h) => h.provider === "aws" && h.monthlyLimit)
      .forEach((h) => {
        awsMonthToDateCost(h.awsProfile ?? undefined)
          .then((c) => setSpend((s) => ({ ...s, [h.id]: c })))
          .catch(() => {});
      });
  }, [allHosts]);

  const openSetup = (id?: string) => serverOpenSetup(id ?? null, "cloud").catch((e) => setError(String(e)));

  const test = useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const r = await serverTest(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) } }));
    }
  }, []);

  async function remove(id: string) {
    try {
      await serverRemove(id);
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function stopLab(l: Lab) {
    if (!l.runtime) return;
    setStopping(l.id);
    try {
      await labStop(l.id, l.runtime.runtime, () => {});
      refreshStatus(l);
    } catch (e) {
      setError(String(e));
    } finally {
      setStopping(null);
    }
  }

  async function installCli(dep: Dependency) {
    setCliBusy(dep);
    try {
      await installDependency(dep, () => {});
      setReport(await systemCheck());
    } catch (e) {
      setError(String(e));
    } finally {
      setCliBusy(null);
    }
  }

  async function login(p: CloudProvider) {
    setLoginBusy(p);
    setError(null);
    try {
      await cloudLogin(p, () => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoginBusy(null);
    }
  }

  async function pull(image: string) {
    setPullBusy(image);
    setError(null);
    try {
      await provisioningPull(image, () => {});
      setProvImages(await provisioningImages());
    } catch (e) {
      setError(String(e));
    } finally {
      setPullBusy(null);
    }
  }

  const over = (hosts ?? []).filter((h) => {
    const s = spend[h.id];
    return h.monthlyLimit != null && s != null && s >= h.monthlyLimit;
  });
  // Labs running on one of these cloud accounts right now (status.host is the account name).
  const accountNames = new Set((hosts ?? []).map((h) => h.name));
  const running = (labs ?? []).filter((l) => {
    const s = statuses[l.id];
    return l.runtime && s?.running && !!s.host && accountNames.has(s.host);
  });
  const envReady = !!report?.cloudClis.aws.installed && !!report?.terraform.installed;
  // Only one install/pull/sign-in at a time: brew (and others) can't run two at once.
  const busyOp = cliBusy !== null || pullBusy !== null || loginBusy !== null;
  const envExpanded = envOpen ?? !envReady;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">Cloud</h1>
        <Button variant="learn" size="sm" onClick={() => openSetup()}>
          <Plus className="size-3.5" /> Set up cloud provider
        </Button>
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

      {over.length > 0 && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-300">
          {over.length === 1 ? `${over[0].name} is over its monthly budget` : `${over.length} accounts are over their monthly budget`} — new labs there are blocked until you raise the budget or next month.
        </p>
      )}

      {running.length > 0 && (
        <Panel>
          <PanelHeader title="Running now" action={<span className="text-[11.5px] text-muted-foreground">Billing while they run</span>} />
          {running.map((l) => {
            const s = statuses[l.id];
            return (
              <div key={l.id} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
                <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{l.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {s?.host}
                    {s?.expiresAt ? ` · auto-stops ${new Date(s.expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => stopLab(l)} disabled={stopping === l.id}>
                  {stopping === l.id ? <Spinner className="size-3.5" /> : <Square className="size-3.5" />} Stop
                </Button>
              </div>
            );
          })}
        </Panel>
      )}

      <Panel>
        <PanelHeader
          title="Accounts"
          action={hosts && hosts.length > 0 ? <span className="text-[11.5px] text-muted-foreground">Billed only while a lab runs; idle accounts cost nothing</span> : undefined}
        />
        {hosts === null ? (
          <div className="flex items-center gap-2 px-3.5 py-4 text-[12.5px] text-muted-foreground"><Spinner className="size-4" /> Loading…</div>
        ) : hosts.length === 0 ? (
          <FirstRun onSetup={() => openSetup()} />
        ) : (
          hosts.map((h) => (
            <AccountRow
              key={h.id}
              host={h}
              test={tests[h.id]}
              spent={spend[h.id]}
              onTest={() => test(h.id)}
              onEdit={() => openSetup(h.id)}
              onRemove={() => remove(h.id)}
            />
          ))
        )}
      </Panel>

      <Panel>
        <button type="button" onClick={() => setEnvOpen(!envExpanded)} className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left">
          <span className="text-[13px] font-semibold tracking-tight">Environment</span>
          <span className={cn("flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", envReady ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500")}>
            <span className={cn("size-1.5 rounded-full", envReady ? "bg-emerald-500" : "bg-amber-500")} />
            {envReady ? "Ready" : "Setup needed"}
          </span>
          <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", envExpanded && "rotate-180")} />
        </button>
        {envExpanded && (
          <div className="border-t border-border">
            <CliRow name="AWS CLI" provider="aws" tool={report?.cloudClis.aws} busy={cliBusy === "awscli"} locked={busyOp} onInstall={() => installCli("awscli")} />
            <ToolRow name="Terraform" note="runs locally; simpler state (Docker image is the fallback)" tool={report?.terraform} busy={cliBusy === "terraform"} locked={busyOp} onInstall={() => installCli("terraform")} />
            {provImages?.map((img) => (
              <ImageRow key={img.image} image={img} note="runs in Docker (best on Windows)" busy={pullBusy === img.image} locked={busyOp} onPull={() => pull(img.image)} />
            ))}
            <div className="border-t border-border px-3.5 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Other providers · provisioning coming</p>
              <div className="mt-2 space-y-1.5">
                <OtherCli name="Azure CLI" provider="azure" tool={report?.cloudClis.azure} busy={cliBusy === "azurecli"} loginBusy={loginBusy === "azure"} locked={busyOp} onInstall={() => installCli("azurecli")} onLogin={() => login("azure")} />
                <OtherCli name="Google Cloud CLI" provider="gcp" tool={report?.cloudClis.gcloud} busy={cliBusy === "gcloud"} loginBusy={loginBusy === "gcp"} locked={busyOp} onInstall={() => installCli("gcloud")} onLogin={() => login("gcp")} />
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

const PROVIDERS: { id: CloudProvider; label: string }[] = [
  { id: "aws", label: "Amazon Web Services" },
  { id: "azure", label: "Microsoft Azure" },
  { id: "gcp", label: "Google Cloud" },
];

function FirstRun({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="flex items-center justify-center gap-3">
        {PROVIDERS.map((p) => (
          // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
          <img key={p.id} src={`/brands/${p.id}.svg`} alt={p.label} className="size-7" draggable={false} />
        ))}
      </div>
      <p className="mt-3 text-[13px] font-medium">Run labs in your own cloud account</p>
      <p className="mx-auto mt-1 max-w-sm text-[12px] text-muted-foreground">
        One throwaway instance per lab, destroyed when you stop it. AWS today; Azure and Google Cloud coming.
      </p>
      <div className="mx-auto mt-5 grid max-w-md gap-2 text-left">
        <Step n={1} title="Connect an account" body="Access keys or your AWS CLI credentials, and a region." />
        <Step n={2} title="Pick it on a lab" body="Terraform creates one instance, reachable over SSH from your IP." />
        <Step n={3} title="Attack, then Stop" body="Stop destroys the instance, so billing stops with it." />
      </div>
      <Button variant="learn" size="sm" className="mt-5" onClick={onSetup}>
        <Plus className="size-3.5" /> Set up cloud provider
      </Button>
    </div>
  );
}

function AccountRow({ host, test, spent, onTest, onEdit, onRemove }: { host: ServerHost; test: ServerTest | "testing" | undefined; spent?: number | null; onTest: () => void; onEdit: () => void; onRemove: () => void }) {
  const result = test && test !== "testing" ? test : null;
  const ok = result ? result.ok : null;
  const [confirming, setConfirming] = useState(false);
  const facts = [
    host.host,
    host.useCliCreds ? (host.awsProfile ? `CLI · ${host.awsProfile}` : "CLI credentials") : "access keys",
    host.autoStopHours ? `auto-stop ${host.autoStopHours}h` : "no auto-stop",
  ];
  return (
    <div className="border-b border-border px-3.5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export, plain asset */}
        <img src="/brands/aws.svg" alt="" className="size-6 shrink-0" draggable={false} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <span className="truncate">{host.name}</span>
            <span className={cn("size-1.5 shrink-0 rounded-full", ok === null ? "bg-muted-foreground/40" : ok ? "bg-emerald-500" : "bg-rose-500")} />
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {facts.join(" · ")}
            {result?.latencyMs != null ? ` · ${result.latencyMs} ms` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {confirming ? (
            <>
              <span className="mr-1 text-[11.5px] text-muted-foreground">Remove?</span>
              <Button variant="destructive" size="sm" onClick={onRemove}>Remove</Button>
              <IconButton label="Cancel" onClick={() => setConfirming(false)}><X className="size-3.5" /></IconButton>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onTest} disabled={test === "testing"}>
                {test === "testing" ? <Spinner className="size-3.5" /> : <Zap className="size-3.5" />} Test
              </Button>
              <IconButton label="Edit" onClick={onEdit}><Pencil className="size-3.5" /></IconButton>
              <IconButton label="Remove" onClick={() => setConfirming(true)}><Trash2 className="size-3.5" /></IconButton>
            </>
          )}
        </div>
      </div>
      {result && (
        <p className={cn("mt-2 flex items-start gap-1.5 pl-9 text-[12px]", ok ? "text-emerald-500" : "text-rose-400")}>
          {ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
          <span>{result.message}</span>
        </p>
      )}
      {host.monthlyLimit != null && (
        <p className={cn("mt-1.5 pl-9 text-[11.5px]", spent != null && spent >= host.monthlyLimit ? "text-rose-400" : "text-muted-foreground")}>
          Budget ${host.monthlyLimit.toFixed(0)}/mo{spent != null ? ` · $${spent.toFixed(2)} this month` : ""}
          {spent != null && spent >= host.monthlyLimit ? " — over budget" : ""}
        </p>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
      {children}
    </button>
  );
}

function Logo({ provider }: { provider: CloudProvider }) {
  // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
  return <img src={`/brands/${provider}.svg`} alt="" className="size-5 shrink-0" draggable={false} />;
}

function Status({ tool }: { tool?: Tool }) {
  const installed = !!tool?.installed;
  return (
    <span className={cn("flex items-center gap-1.5 text-[12px]", installed ? "text-emerald-500" : "text-muted-foreground")}>
      {installed && <span className="size-1.5 rounded-full bg-emerald-500" />}
      {tool ? (installed ? (tool.version ?? "installed") : "not installed") : "…"}
    </span>
  );
}

function CliRow({ name, provider, tool, busy, locked, onInstall }: { name: string; provider: CloudProvider; tool?: Tool; busy: boolean; locked: boolean; onInstall: () => void }) {
  const installed = !!tool?.installed;
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px]">
      <Logo provider={provider} />
      <span className="text-foreground">{name}</span>
      <span className="ml-auto flex items-center gap-3">
        <Status tool={tool} />
        {!installed && tool && (
          <Button variant="learn" size="sm" onClick={onInstall} disabled={busy || locked}>{busy ? "Installing…" : "Install"}</Button>
        )}
      </span>
    </div>
  );
}

function ToolRow({ name, note, tool, busy, locked, onInstall }: { name: string; note: string; tool?: Tool; busy: boolean; locked: boolean; onInstall: () => void }) {
  const installed = !!tool?.installed;
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px]">
      <span className="font-medium text-foreground">{name}</span>
      <span className="truncate text-[11.5px] text-muted-foreground">{note}</span>
      <span className="ml-auto flex items-center gap-3">
        <Status tool={tool} />
        {!installed && tool && (
          <Button variant="learn" size="sm" onClick={onInstall} disabled={busy || locked}>{busy ? "Installing…" : "Install"}</Button>
        )}
      </span>
    </div>
  );
}

function ImageRow({ image, note, busy, locked, onPull }: { image: ProvisioningImage; note: string; busy: boolean; locked: boolean; onPull: () => void }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px]">
      <span className="font-medium text-foreground">{image.name}</span>
      <span className="truncate text-[11.5px] text-muted-foreground">{note}</span>
      <span className="ml-auto flex items-center gap-3">
        <span className={cn("flex items-center gap-1.5", image.present ? "text-emerald-500" : "text-muted-foreground")}>
          {image.present && <span className="size-1.5 rounded-full bg-emerald-500" />}
          {image.present ? "pulled" : "not pulled"}
        </span>
        {!image.present && <Button variant="learn" size="sm" onClick={onPull} disabled={busy || locked}>{busy ? "Pulling…" : "Pull"}</Button>}
      </span>
    </div>
  );
}

function OtherCli({ name, provider, tool, busy, loginBusy, locked, onInstall, onLogin }: { name: string; provider: CloudProvider; tool?: Tool; busy: boolean; loginBusy: boolean; locked: boolean; onInstall: () => void; onLogin: () => void }) {
  const installed = !!tool?.installed;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <Logo provider={provider} />
      <span className="text-muted-foreground">{name}</span>
      <span className="ml-auto flex items-center gap-2">
        {installed ? (
          <Button variant="ghost" size="sm" onClick={onLogin} disabled={loginBusy || locked}>{loginBusy ? "Signing in…" : "Sign in"}</Button>
        ) : tool ? (
          <Button variant="ghost" size="sm" onClick={onInstall} disabled={busy || locked}>{busy ? "Installing…" : "Install"}</Button>
        ) : null}
      </span>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">{n}</span>
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium">{title}</p>
        <p className="text-[11.5px] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
