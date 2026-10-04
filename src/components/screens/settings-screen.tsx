"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { ArrowRight, Check, Copy, LogOut, RotateCcw } from "lucide-react";
import { initials, useAuthActions } from "@/components/Account";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { agentInfo, systemCheck, type AgentInfo, type AuthStatus, type Provider, type ProviderStatus, type SystemReport } from "@/lib/tauri";
import {
  ATTACK_PRESETS,
  DEFAULT_ATTACK_IMAGE,
  getAttackImage,
  getAutoAttackBox,
  getVmProvider,
  setAttackImage,
  setAutoAttackBox,
  setVmProvider,
} from "@/lib/settings";
import { providerLabel } from "@/lib/hypervisors";
import { cn } from "@/lib/utils";

const ONBOARDED_KEY = "cyberctf.onboarded";

/* ------------------------------------------------------------------ layout */

function Section({ title, description, saved, children }: { title: string; description?: string; saved?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4 px-0.5">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{description}</p>}
        </div>
        <span
          aria-live="polite"
          className={cn("flex items-center gap-1 text-xs text-emerald-500 transition-opacity duration-300", saved ? "opacity-100" : "opacity-0")}
        >
          <Check className="size-3.5" /> Saved
        </span>
      </div>
      <Card className="divide-y divide-border">{children}</Card>
    </section>
  );
}

/** One setting: label + description on the left, its control on the right (or below, when `stacked`). */
function Row({
  title,
  description,
  control,
  stacked,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  stacked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="px-5 py-4">
      <div className={cn("flex gap-6", stacked ? "flex-col gap-3" : "items-center justify-between")}>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">{description}</div>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/** Flashes the section's "Saved" mark for a moment after a change. */
function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return [
    saved,
    () => {
      setSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 1600);
    },
  ];
}

/* ------------------------------------------------------------------ screen */

export function SettingsScreen({
  auth,
  onAuthChange,
  onNavigate,
}: {
  auth: AuthStatus | null;
  onAuthChange: (status: AuthStatus) => void;
  onNavigate: (tab: "machine") => void;
}) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [report, setReport] = useState<SystemReport | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [labsSaved, flashLabs] = useSavedFlash();

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
    systemCheck()
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  // The agent registers once signed in, so re-read it whenever auth changes.
  useEffect(() => {
    if (auth?.loggedIn)
      agentInfo()
        .then(setAgent)
        .catch(() => setAgent(null));
  }, [auth?.loggedIn]);

  return (
    <div className="mx-auto max-w-[760px] space-y-9 pb-10">
      <AccountSection auth={auth} agent={auth?.loggedIn ? agent : null} onAuthChange={onAuthChange} />

      <Section title="Labs" description="How labs start on this machine. Saved on this computer only." saved={labsSaved}>
        <AttackBoxRows onSaved={flashLabs} />
        <HypervisorRow report={report} onSaved={flashLabs} onNavigate={onNavigate} />
      </Section>

      <AboutSection version={version} report={report} agent={auth?.loggedIn ? agent : null} />
    </div>
  );
}

/* ------------------------------------------------------------------ account */

function AccountSection({ auth, agent, onAuthChange }: { auth: AuthStatus | null; agent: AgentInfo | null; onAuthChange: (s: AuthStatus) => void }) {
  const { login, logout, busy, error } = useAuthActions(onAuthChange);

  return (
    <Section title="Account" description="Signing in registers this machine, so labs you launch from the website run here.">
      {auth === null ? (
        <Row
          title={
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Checking…
            </span>
          }
        />
      ) : auth.loggedIn ? (
        <>
          <div className="flex items-center gap-3.5 px-5 py-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-learn/15 text-sm font-semibold text-learn">
              {initials(auth.name, auth.email)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{auth.name ?? "Signed in"}</p>
              {auth.email && <p className="truncate text-[0.8125rem] text-muted-foreground">{auth.email}</p>}
            </div>
            <Button variant="outline" size="sm" onClick={logout}>
              <LogOut className="size-3.5" /> Sign out
            </Button>
          </div>
          <Row
            title={
              <span className="flex items-center gap-2">
                This machine
                <Badge variant="success" dot>
                  Online
                </Badge>
              </span>
            }
            description={
              agent ? (
                <>
                  {agent.name} <span className="text-muted-foreground/60">·</span> <span className="font-mono text-xs">{agent.arch}</span>
                  {agent.capabilities.length > 0 && (
                    <>
                      {" "}
                      <span className="text-muted-foreground/60">·</span> runs {agent.capabilities.join(", ")}
                    </>
                  )}
                </>
              ) : (
                "Registering…"
              )
            }
          />
        </>
      ) : (
        <Row
          title={
            <span className="flex items-center gap-2">
              Not signed in
              <Badge variant="outline">Offline</Badge>
            </span>
          }
          description={error ? <span className="text-destructive">{error}</span> : "Sign in with your Cyber account to sync labs and run them from any device."}
          control={
            <Button variant="learn" size="sm" onClick={login} disabled={busy}>
              {busy ? (
                <>
                  <Spinner className="size-3.5" /> Waiting for the browser…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          }
        />
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ labs */

function AttackBoxRows({ onSaved }: { onSaved: () => void }) {
  const [image, setImage] = useState(() => getAttackImage());
  const isPreset = ATTACK_PRESETS.some((p) => p.image === image);
  const [customOpen, setCustomOpen] = useState(!isPreset);
  const [draft, setDraft] = useState(isPreset ? "" : image);
  const [autoStart, setAutoStart] = useState(() => getAutoAttackBox());

  function choose(next: string) {
    const value = next.trim() || DEFAULT_ATTACK_IMAGE;
    setAttackImage(value);
    setImage(value);
    onSaved();
  }

  const customDirty = draft.trim() !== "" && draft.trim() !== image;

  return (
    <>
      <Row
        stacked
        title="Attack box image"
        description="Runs on each lab’s network as your toolbox. The first launch of an image downloads it, which can take a while."
      >
        <div role="radiogroup" aria-label="Attack box image" className="mt-3 overflow-hidden rounded-lg border border-border">
          {ATTACK_PRESETS.map((p) => (
            <OptionRow
              key={p.image}
              selected={!customOpen && image === p.image}
              onSelect={() => {
                setCustomOpen(false);
                choose(p.image);
              }}
              title={
                <>
                  {p.label}
                  {p.image === DEFAULT_ATTACK_IMAGE && <Badge>Default</Badge>}
                  {p.large && <Badge variant="outline">Large download</Badge>}
                  {p.terms && <Badge variant="warning">{p.terms}</Badge>}
                </>
              }
              subtitle={
                <>
                  <span className="font-mono">{p.image}</span> <span className="text-muted-foreground/60">·</span> {p.note}
                </>
              }
            />
          ))}
          <OptionRow selected={customOpen} onSelect={() => setCustomOpen(true)} title="Custom image" subtitle="Any Docker image or registry tag.">
            {customOpen && (
              <form
                className="mt-2.5 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (customDirty) choose(draft);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  spellCheck={false}
                  placeholder="registry/image:tag"
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:border-ring"
                />
                <Button type="submit" variant="outline" size="sm" disabled={!customDirty} onClick={(e) => e.stopPropagation()}>
                  Save
                </Button>
              </form>
            )}
          </OptionRow>
        </div>
      </Row>

      <Row
        title="Start the attack box with the lab"
        description="Starts it as soon as a local container lab is up. You can still start or stop it from the lab."
        control={
          <Switch
            aria-label="Start the attack box with the lab"
            checked={autoStart}
            onCheckedChange={(on) => {
              setAutoAttackBox(on);
              setAutoStart(on);
              onSaved();
            }}
          />
        }
      />
    </>
  );
}

function OptionRow({
  selected,
  onSelect,
  title,
  subtitle,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  subtitle: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer gap-3 border-b border-border px-3.5 py-3 outline-none transition-colors last:border-0 focus-visible:bg-muted",
        selected ? "bg-learn/[0.06]" : "hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-learn" : "border-muted-foreground/40",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-learn" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] font-medium text-foreground">{title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
        {children}
      </div>
    </div>
  );
}

function HypervisorRow({ report, onSaved, onNavigate }: { report: SystemReport | null; onSaved: () => void; onNavigate: (tab: "machine") => void }) {
  const [provider, setProvider] = useState<Provider | null>(() => getVmProvider());
  // Local hypervisors VM labs can start on right now (hypervisor + Vagrant plugin ready).
  const ready: ProviderStatus[] | null = report ? report.vmProviders.filter((p) => !p.remote && p.available && p.hypervisor !== false) : null;
  // A saved choice that's no longer installed falls back to automatic.
  const effective = ready?.some((h) => h.provider === provider) ? provider : null;

  function choose(p: Provider | null) {
    setVmProvider(p);
    setProvider(p);
    onSaved();
  }

  const setupLink = (
    <button onClick={() => onNavigate("machine")} className="inline-flex items-center gap-1 text-link underline-offset-4 hover:underline">
      Set one up on the Machine page <ArrowRight className="size-3" />
    </button>
  );

  if (ready === null) {
    return (
      <Row
        title="Hypervisor for VM labs"
        description={
          <span className="flex items-center gap-2">
            <Spinner className="size-3" /> Checking hypervisors…
          </span>
        }
      />
    );
  }

  if (ready.length === 0) {
    return <Row title="Hypervisor for VM labs" description={<>No hypervisor is ready on this machine yet. {setupLink}</>} />;
  }

  const options: (Provider | null)[] = ready.length > 1 ? [null, ...ready.map((h) => h.provider)] : [];

  return (
    <Row
      title="Hypervisor for VM labs"
      description={
        ready.length === 1 ? (
          <>VM labs run on {providerLabel(ready[0])}, the only hypervisor ready here.</>
        ) : effective === null ? (
          <>Automatic picks {providerLabel(ready[0])}, the first ready hypervisor.</>
        ) : (
          <>VM labs and the VM test run on {providerLabel(ready.find((h) => h.provider === effective)!)}.</>
        )
      }
      control={
        ready.length === 1 ? (
          <Badge variant="success" dot>
            {providerLabel(ready[0])}
          </Badge>
        ) : (
          <div role="radiogroup" aria-label="Hypervisor" className="inline-flex rounded-lg border border-border bg-background p-0.5">
            {options.map((p) => {
              const active = effective === p;
              const status = ready.find((h) => h.provider === p);
              return (
                <button
                  key={p ?? "auto"}
                  role="radio"
                  aria-checked={active}
                  onClick={() => choose(p)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    active ? "bg-muted text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p === null ? "Automatic" : status ? providerLabel(status) : p}
                </button>
              );
            })}
          </div>
        )
      }
    />
  );
}

/* ------------------------------------------------------------------ about */

type UpdateState = { phase: "idle" | "checking" | "none" | "error" } | { phase: "available" | "installing" | "installed"; update: Update };

function AboutSection({ version, report, agent }: { version: string | null; report: SystemReport | null; agent: AgentInfo | null }) {
  const [upd, setUpd] = useState<UpdateState>({ phase: "idle" });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  async function checkUpdates() {
    setUpd({ phase: "checking" });
    try {
      const u = await check();
      setUpd(u ? { phase: "available", update: u } : { phase: "none" });
    } catch {
      setUpd({ phase: "error" });
    }
    setCheckedAt(Date.now());
  }

  async function install() {
    if (!("update" in upd)) return;
    const { update } = upd;
    setUpd({ phase: "installing", update });
    try {
      await update.downloadAndInstall();
      setUpd({ phase: "installed", update });
    } catch {
      setUpd({ phase: "available", update });
    }
  }

  async function copyDiagnostics() {
    const lines = [
      `Cyber CTF ${version ? `v${version}` : "(unknown version)"}`,
      report ? `OS: ${report.os} ${report.arch}` : null,
      report
        ? `Docker: ${report.dockerRunning ? `running (${report.dockerEngine ?? "unknown engine"})` : report.docker.installed ? "installed, not running" : "not installed"}`
        : null,
      report
        ? `Vagrant: ${report.vagrant.installed ? "installed" : "not installed"} · Terraform: ${report.terraform.installed ? "installed" : "not installed"}`
        : null,
      report
        ? `Hypervisors ready: ${
            report.vmProviders
              .filter((p) => !p.remote && p.available)
              .map((p) => p.provider)
              .join(", ") || "none"
          }`
        : null,
      `Attack box: ${getAttackImage()}`,
      `VM provider: ${getVmProvider() ?? "automatic"}`,
      agent ? `Install ID: ${agent.installId}` : "Not signed in",
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  function replayOnboarding() {
    try {
      localStorage.removeItem(ONBOARDED_KEY);
    } catch {
      /* ignore */
    }
    location.reload();
  }

  const updateText = (() => {
    switch (upd.phase) {
      case "checking":
        return "Checking for updates…";
      case "none":
        return `You’re on the latest version${checkedAt ? `, checked at ${new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.`;
      case "error":
        return "Couldn’t reach the update server. Check your connection and try again.";
      case "available":
        return `Version ${upd.update.version} is available.`;
      case "installing":
        return `Downloading and installing ${upd.update.version}…`;
      case "installed":
        return `Version ${upd.update.version} is installed. Restart Cyber CTF to apply it.`;
      default:
        return "Updates install automatically when you accept them from the banner.";
    }
  })();

  return (
    <Section title="About">
      <Row
        title={
          <span className="flex items-center gap-2">
            Cyber CTF <span className="font-mono text-[0.8125rem] font-normal text-muted-foreground">{version ? `v${version}` : "…"}</span>
            {upd.phase === "available" && <Badge variant="accent">Update available</Badge>}
          </span>
        }
        description={updateText}
        control={
          upd.phase === "available" || upd.phase === "installing" ? (
            <Button variant="learn" size="sm" onClick={install} disabled={upd.phase === "installing"}>
              {upd.phase === "installing" ? (
                <>
                  <Spinner className="size-3.5" /> Installing…
                </>
              ) : (
                "Install update"
              )}
            </Button>
          ) : upd.phase === "installed" ? null : (
            <Button variant="outline" size="sm" onClick={checkUpdates} disabled={upd.phase === "checking"}>
              {upd.phase === "checking" ? (
                <>
                  <Spinner className="size-3.5" /> Checking…
                </>
              ) : (
                "Check for updates"
              )}
            </Button>
          )
        }
      />
      <Row
        title="Diagnostics"
        description="Copies your version, OS and setup status, for a bug report or a support request."
        control={
          <Button variant="outline" size="sm" onClick={copyDiagnostics}>
            {copied ? (
              <>
                <Check className="size-3.5 text-emerald-500" /> Copied
              </>
            ) : (
              <>
                <Copy className="size-3.5" /> Copy
              </>
            )}
          </Button>
        }
      />
      <Row
        title="First-run setup"
        description="Walk through the onboarding again. Your settings and labs are kept."
        control={
          <Button variant="ghost" size="sm" onClick={replayOnboarding}>
            <RotateCcw className="size-3.5" /> Replay
          </Button>
        }
      />
    </Section>
  );
}
