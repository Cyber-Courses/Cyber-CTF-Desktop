"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, Cloud, MoreHorizontal, Pencil, Plus, RefreshCw, Server, Star, Trash2, Zap } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { KIND } from "@/components/server/host-setup";
import {
  cloudLogin,
  installDependency,
  provisioningImages,
  provisioningPull,
  SERVER_CHANGED,
  serverList,
  serverOpenSetup,
  serverRemove,
  serverRunningLabs,
  serverSetDefault,
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

type Tab = "setup";
type Tone = "ok" | "warn" | "fail" | "muted";

const COPY = {
  server: {
    add: "Add host",
    panel: "Hosts",
    unit: "host",
    emptyTitle: "No server connected",
    emptyBody: "Add your Proxmox or ESXi server to run heavier, multi-VM labs on it instead of this machine.",
    removed: "password",
  },
  cloud: {
    add: "Set up cloud provider",
    panel: "Accounts",
    unit: "account",
    emptyTitle: "No cloud account connected",
    emptyBody: "Connect an AWS account to run labs as throwaway instances in the cloud.",
    removed: "secret key",
  },
};

/** Dot + label, in the machine-page style, so status reads the same across the app. */
function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = { ok: "text-emerald-500", warn: "text-amber-500", fail: "text-rose-500", muted: "text-muted-foreground" }[tone];
  const dot = { ok: "bg-emerald-500", warn: "bg-amber-500", fail: "bg-rose-500", muted: "bg-muted-foreground/50" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", c)}>
      <span className={cn("size-1.5 rounded-full", dot)} />
      {children}
    </span>
  );
}

function TypeIcon({ children }: { children: ReactNode }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground">{children}</span>;
}

export function ServerScreen({ onNavigate, kind = "server" }: { onNavigate: (tab: Tab) => void; kind?: "server" | "cloud" }) {
  const copy = COPY[kind];
  const cloud = kind === "cloud";
  const [allHosts, setHosts] = useState<ServerHost[] | null>(null);
  const hosts = allHosts?.filter((h) => (h.provider === "aws") === cloud) ?? null;
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ServerTest | "testing">>({});
  const [running, setRunning] = useState<Record<string, number>>({});
  const [report, setReport] = useState<SystemReport | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [provImages, setProvImages] = useState<ProvisioningImage[] | null>(null);
  const [pullBusy, setPullBusy] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);

  const test = useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const r = await serverTest(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) } }));
    }
  }, []);

  // Auto-test every host as it loads, so the status is live without clicking. The `tested`
  // guard keeps a given host from re-testing on every render.
  const tested = useRef<Set<string>>(new Set());
  const reload = useCallback(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        setDefaultId(l.default);
        setError(null);
        for (const h of l.hosts) {
          if (!tested.current.has(h.id)) {
            tested.current.add(h.id);
            test(h.id);
          }
        }
      })
      .catch((e) => setError(String(e)));
  }, [test]);
  useEffect(reload, [reload]);

  // Running-labs-per-host, refreshed on a slow poll (labs start and stop from other screens).
  const loadRunning = useCallback(() => {
    serverRunningLabs().then(setRunning).catch(() => {});
  }, []);
  useEffect(() => {
    loadRunning();
    const timer = setInterval(loadRunning, 8000);
    return () => clearInterval(timer);
  }, [loadRunning]);

  // The setup window saves hosts; refresh (and re-test the changed one) when it says so.
  useEffect(() => {
    const off = listen(SERVER_CHANGED, () => {
      tested.current.clear();
      reload();
      loadRunning();
    });
    return () => {
      off.then((f) => f()).catch(() => {});
    };
  }, [reload, loadRunning]);

  useEffect(() => {
    // The report tells us whether this machine can already run VM labs (so the server
    // page can hide the "set up this machine" hint), and feeds the cloud requirements.
    systemCheck().then(setReport).catch(() => {});
    if (cloud) provisioningImages().then(setProvImages).catch(() => {});
  }, [cloud]);

  const open = (id: string | null) => serverOpenSetup(id, kind).catch((e) => setError(String(e)));
  const testAll = () => hosts?.forEach((h) => test(h.id));

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
  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const online = hosts?.filter((h) => tests[h.id] && tests[h.id] !== "testing" && (tests[h.id] as ServerTest).ok).length ?? 0;
  const anyTesting = !!hosts?.some((h) => tests[h.id] === "testing");
  const hasHosts = !!hosts && hosts.length > 0;
  const summaryTone: Tone = !hasHosts ? "warn" : anyTesting ? "muted" : online === hosts!.length ? "ok" : online > 0 ? "warn" : "fail";
  const summaryText = !hasHosts
    ? cloud ? "No account connected" : "No server connected"
    : anyTesting ? "Checking…" : `${online} of ${hosts!.length} online`;

  return (
    <div className="space-y-5">
      {/* Summary strip, matching the machine page: status pill, muted meta, actions pinned right. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium",
          summaryTone === "ok" ? "border-emerald-500/30 text-emerald-500" : summaryTone === "fail" ? "border-rose-500/30 text-rose-500" : summaryTone === "muted" ? "border-border text-muted-foreground" : "border-amber-500/30 text-amber-500")}
        >
          <span className={cn("size-1.5 rounded-full", summaryTone === "ok" ? "bg-emerald-500" : summaryTone === "fail" ? "bg-rose-500" : summaryTone === "muted" ? "bg-muted-foreground/50" : "bg-amber-500")} />
          {summaryText}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {cloud ? "AWS EC2 in your own account" : "Proxmox or ESXi, over your network"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {hasHosts && (
            <Button variant="outline" size="sm" onClick={testAll} disabled={anyTesting}>
              {anyTesting ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} Test all
            </Button>
          )}
          <Button variant="learn" size="sm" onClick={() => open(null)}>
            <Plus className="size-3.5" /> {copy.add}
          </Button>
        </div>
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

      {/* Hosts: the hero. */}
      <Panel>
        <PanelHeader title={copy.panel} action={hasHosts ? <span className="text-[11.5px] tabular-nums text-muted-foreground">{hosts!.length} {copy.unit}{hosts!.length > 1 ? "s" : ""}</span> : undefined} />
        {hosts === null ? (
          <div className="space-y-2 p-3.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !hasHosts ? (
          <EmptyState cloud={cloud} title={copy.emptyTitle} body={copy.emptyBody} cta={copy.add} onAdd={() => open(null)} />
        ) : (
          hosts.map((h) => (
            <HostRow
              key={h.id}
              host={h}
              isDefault={h.id === defaultId}
              canDefault={!cloud}
              running={running[h.id] ?? 0}
              test={tests[h.id]}
              onTest={() => test(h.id)}
              onEdit={() => open(h.id)}
              onDefault={() => act(() => serverSetDefault(h.id === defaultId ? null : h.id))}
              onRemove={() => {
                if (confirm(`Remove ${h.name}? Its ${copy.removed} is deleted from the keychain.`)) act(() => serverRemove(h.id));
              }}
            />
          ))
        )}
      </Panel>

      {/* How it works: a Panel when empty (teaching), a Details disclosure once there are hosts. */}
      {!hasHosts ? (
        <Panel>
          <PanelHeader title="How it works" />
          <HowItWorks cloud={cloud} />
        </Panel>
      ) : (
        <Disclosure summary="How it works">
          <Panel className="mt-2.5"><HowItWorks cloud={cloud} /></Panel>
        </Disclosure>
      )}

      {/* Cloud setup requirements, folded into a Details disclosure like the machine page. */}
      {cloud && (
        <Disclosure summary="Requirements">
          <Panel className="mt-2.5">
            <PanelHeader title="Command-line tools" action={<span className="text-[11.5px] text-muted-foreground">AWS is used today; Azure / GCP coming</span>} />
            <CliRow name="AWS CLI" provider="aws" tool={report?.cloudClis.aws} busy={cliBusy === "awscli"} loginBusy={loginBusy === "aws"} onInstall={() => installCli("awscli")} onLogin={() => login("aws")} />
            <CliRow name="Azure CLI" provider="azure" tool={report?.cloudClis.azure} busy={cliBusy === "azurecli"} loginBusy={loginBusy === "azure"} onInstall={() => installCli("azurecli")} onLogin={() => login("azure")} />
            <CliRow name="Google Cloud CLI" provider="gcp" tool={report?.cloudClis.gcloud} busy={cliBusy === "gcloud"} loginBusy={loginBusy === "gcp"} onInstall={() => installCli("gcloud")} onLogin={() => login("gcp")} />
          </Panel>
          <Panel className="mt-3">
            <PanelHeader title="Provisioning" action={<span className="text-[11.5px] text-muted-foreground">Terraform creates, Ansible configures</span>} />
            <ToolRow name="Terraform" note="runs locally" tool={report?.terraform} busy={cliBusy === "terraform"} onInstall={() => installCli("terraform")} />
            {provImages === null ? (
              <div className="flex items-center gap-2 px-3.5 py-4 text-[12.5px] text-muted-foreground"><Spinner className="size-4" /> Checking…</div>
            ) : (
              provImages.map((img) => <ImageRow key={img.image} image={img} note="runs in Docker (best on Windows)" busy={pullBusy === img.image} onPull={() => pull(img.image)} />)
            )}
          </Panel>
        </Disclosure>
      )}

      {/* Only worth suggesting when this machine can't already run VM labs itself. */}
      {!cloud && report && !report.vmProviders.some((p) => !p.remote && p.available && p.hypervisor !== false) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">No server? If this machine can handle it, install a local hypervisor and run VM labs here.</p>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("setup")}>Set up this machine</Button>
        </div>
      )}
    </div>
  );
}

function HowItWorks({ cloud }: { cloud: boolean }) {
  return cloud ? (
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
  );
}

function EmptyState({ cloud, title, body, cta, onAdd }: { cloud: boolean; title: string; body: string; cta: string; onAdd: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border bg-surface text-muted-foreground">
        {cloud ? <Cloud className="size-5" /> : <Server className="size-5" />}
      </span>
      <p className="mt-4 text-[14px] font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-muted-foreground">{body}</p>
      <Button variant="learn" size="sm" className="mt-5" onClick={onAdd}><Plus className="size-3.5" /> {cta}</Button>
    </div>
  );
}

function HostRow({
  host,
  isDefault,
  canDefault,
  running,
  test,
  onTest,
  onEdit,
  onDefault,
  onRemove,
}: {
  host: ServerHost;
  isDefault: boolean;
  canDefault: boolean;
  running: number;
  test: ServerTest | "testing" | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDefault: () => void;
  onRemove: () => void;
}) {
  const result = test && test !== "testing" ? test : null;
  const tone: Tone = test === "testing" || !test ? "muted" : result!.ok ? "ok" : "fail";
  const status = test === "testing" ? "Testing…" : !test ? "Not tested" : result!.ok ? "Online" : "Unreachable";
  const endpoint = host.provider === "aws" ? `AWS · ${host.host}` : `${KIND[host.provider].label} · ${host.username}@${host.host}:${host.port}${host.node ? ` · node ${host.node}` : ""}`;
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <TypeIcon>{host.provider === "aws" ? <Cloud className="size-4" /> : <Server className="size-4" />}</TypeIcon>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] font-medium">
            {host.name}
            <StatusPill tone={tone}>
              {status}
              {result?.latencyMs != null && <span className="ml-1 font-mono text-[10.5px] tabular-nums text-muted-foreground">{result.latencyMs} ms</span>}
            </StatusPill>
            {canDefault && (
              <button
                type="button"
                onClick={onDefault}
                title={isDefault ? "The default host for website launches. Click to unset." : "Make this the default host for website launches."}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide transition-colors",
                  isDefault ? "border-learn/50 bg-learn/10 text-learn" : "border-border text-muted-foreground/70 hover:border-ring/60 hover:text-foreground",
                )}
              >
                <Star className={cn("size-2.5", isDefault && "fill-current")} /> Default
              </button>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
            <span className="truncate font-mono">{endpoint}</span>
            {running > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-learn">
                <span className="size-1.5 rounded-full bg-learn" />
                {running} lab{running > 1 ? "s" : ""} running
              </span>
            )}
          </p>
          {result && !result.ok && <p className="mt-1 text-[12px] text-rose-500">{result.message}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onTest} disabled={test === "testing"}>
            {test === "testing" ? <Spinner className="size-3.5" /> : <Zap className="size-3.5" />} Test
          </Button>
          <Menu items={[{ label: "Edit", icon: Pencil, onClick: onEdit }, { label: "Remove", icon: Trash2, danger: true, onClick: onRemove }]} />
        </div>
      </div>
    </div>
  );
}

type MenuItem = { label: string; icon: typeof Pencil; onClick: () => void; danger?: boolean };
function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="More actions"
        onClick={() => setOpen((o) => !o)}
        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <>
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-20 w-36 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted", it.danger ? "text-rose-500" : "text-foreground")}
              >
                <it.icon className="size-3.5" /> {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A native Details disclosure, same affordance as the machine page's "Details". */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> {summary}
      </summary>
      {children}
    </details>
  );
}

function CloudMark({ provider }: { provider: CloudProvider }) {
  // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
  return <img src={`/brands/${provider}.svg`} alt="" className="size-5 shrink-0" draggable={false} />;
}

function CliRow({ name, provider, tool, busy, loginBusy, onInstall, onLogin }: { name: string; provider: CloudProvider; tool?: Tool; busy: boolean; loginBusy: boolean; onInstall: () => void; onLogin: () => void }) {
  const installed = !!tool?.installed;
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <CloudMark provider={provider} />
      <span className="text-foreground">{name}</span>
      <span className="ml-auto flex items-center gap-3">
        <StatusPill tone={installed ? "ok" : "muted"}>{tool ? (installed ? (tool.version ?? "installed") : "not installed") : "…"}</StatusPill>
        {installed ? (
          provider === "aws" ? null : (
            <Button variant="outline" size="sm" onClick={onLogin} disabled={loginBusy}>
              {loginBusy ? "Signing in…" : "Sign in"}
            </Button>
          )
        ) : tool ? (
          <Button variant="learn" size="sm" onClick={onInstall} disabled={busy}>
            {busy ? "Installing…" : "Install"}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function ToolRow({ name, note, tool, busy, onInstall }: { name: string; note: string; tool?: Tool; busy: boolean; onInstall: () => void }) {
  const installed = !!tool?.installed;
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <span className="font-medium text-foreground">{name}</span>
      <span className="truncate text-[11.5px] text-muted-foreground">{note}</span>
      <span className="ml-auto flex items-center gap-3">
        <StatusPill tone={installed ? "ok" : "muted"}>{tool ? (installed ? (tool.version ?? "installed") : "not installed") : "…"}</StatusPill>
        {!installed && tool && (
          <Button variant="learn" size="sm" onClick={onInstall} disabled={busy}>
            {busy ? "Installing…" : "Install"}
          </Button>
        )}
      </span>
    </div>
  );
}

function ImageRow({ image, note, busy, onPull }: { image: ProvisioningImage; note: string; busy: boolean; onPull: () => void }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <span className="font-medium text-foreground">{image.name}</span>
      <span className="truncate text-[11.5px] text-muted-foreground">{note}</span>
      <code className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{image.image}</code>
      <span className="ml-auto flex items-center gap-3">
        <StatusPill tone={image.present ? "ok" : "muted"}>{image.present ? "pulled" : "not pulled"}</StatusPill>
        {!image.present && (
          <Button variant="learn" size="sm" onClick={onPull} disabled={busy}>
            {busy ? "Pulling…" : "Pull"}
          </Button>
        )}
      </span>
    </div>
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
