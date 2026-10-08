"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, Cloud, Cog, FlaskConical, LayoutDashboard, type LucideIcon, MonitorCog, Search, Server } from "lucide-react";
import { Account } from "@/features/account/account";
import { Labs } from "@/features/labs/labs-screen";
import { HomeScreen } from "@/features/home/home-screen";
import { MachineScreen } from "@/features/machine/machine-screen";
import { ServerScreen } from "@/features/servers/servers-screen";
import { CloudScreen } from "@/features/cloud/cloud-screen";
import { SettingsScreen } from "@/features/settings/settings-screen";
import { CommandPalette, type Command } from "@/components/command-palette";
import { QuitGuard } from "@/features/app/quit-guard";
import { LaunchConfirm } from "@/features/app/launch-confirm";
import { Onboarding } from "@/features/onboarding/onboarding";
import { UpdateBanner } from "@/components/update-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { apiQuery, authLogin, authStatus, machineWorkloads, openSettings, systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { operationLabel, SIGNED_OUT_EVENT, useActiveOperations, useDeployingLabs } from "@/lib/deploy-store";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ignore, tell, warn } from "@/lib/failure";

/** Broadcast to every window when the session changes in one of them. */
const AUTH_CHANGED_EVENT = "cyberctf:auth-changed";

type Tab = "home" | "labs" | "machine" | "setup" | "server" | "cloud" | "events" | "settings";

const ONBOARDED_KEY = "cyberctf.onboarded";

// Grouped: the lab area (what you run), then the setup area (the compute it runs on), then
// Settings. `sep` draws a divider before the item, at each group boundary.
const NAV: { id: Tab; label: string; icon: LucideIcon; soon?: boolean; sep?: boolean }[] = [
  { id: "home", label: "Overview", icon: LayoutDashboard },
  { id: "labs", label: "Labs", icon: FlaskConical },
  { id: "events", label: "Events", icon: CalendarDays, soon: true },
  { id: "machine", label: "Machine", icon: MonitorCog, sep: true },
  { id: "server", label: "Servers", icon: Server },
  { id: "cloud", label: "Cloud", icon: Cloud },
];

const TITLES: Record<Tab, string> = {
  home: "Overview",
  labs: "Labs",
  machine: "Machine",
  setup: "Setup",
  server: "Servers",
  cloud: "Cloud",
  events: "Events",
  settings: "Settings",
};

export function AppShell() {
  const [tab, setTab] = useState<Tab>("home");
  const [openLab, setOpenLab] = useState<{ slug: string | null; tick: number }>({ slug: null, tick: 0 });
  const [report, setReport] = useState<SystemReport | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [onboarded, setOnboarded] = useState(true);
  const [ready, setReady] = useState(false);
  // This webview is the dedicated Settings window (opened by `open_settings` with ?window=settings).
  const [settingsWindow, setSettingsWindow] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A light lab list for the command palette (jump straight to a lab), refreshed on auth change.
  const [palLabs, setPalLabs] = useState<{ id: string; slug: string; title: string; category: string }[]>([]);

  const check = () =>
    systemCheck()
      .then(setReport)
      .catch(() => setReport(null));
  useEffect(() => {
    try {
      // Reads the window marker once on mount (window isn't available during render).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSettingsWindow(new URLSearchParams(window.location.search).get("window") === "settings");
    } catch {
      /* ignore */
    }
    check();
    authStatus()
      .then(setAuth)
      .catch(() => setAuth({ loggedIn: false, name: null, email: null }));
    try {
      // Reads a per-machine flag once on mount (localStorage isn't available during render).
      setOnboarded(localStorage.getItem(ONBOARDED_KEY) === "1");
    } catch {
      setOnboarded(true);
    }
    setReady(true);
  }, []);

  function navigate(next: Tab, slug?: string) {
    // Setup now lives inside the Machine dashboard; "setup" just lands on Machine.
    if (next === "setup") {
      setTab("machine");
      setOpenLab((o) => ({ slug: null, tick: o.tick + 1 }));
      return;
    }
    setTab(next);
    setOpenLab((o) => ({ slug: slug ?? null, tick: o.tick + 1 }));
  }

  function findALab() {
    setTab("labs");
    setOpenLab((o) => ({ slug: null, tick: o.tick + 1 }));
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-lab-search]")?.focus());
  }

  // Keyboard: ⌘K / Ctrl+K opens the command palette; "/" jumps to Labs search. Both are ignored
  // while the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      findALab();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The session can disappear under the app (signed out elsewhere, a refresh token revoked, the
  // keychain locked or cleared). Re-read it when an action says so, when the window comes back,
  // and now and then while signed in, so the sidebar and Start buttons don't claim a session
  // that's gone.
  const loggedIn = !!auth?.loggedIn;
  useEffect(() => {
    const reread = () => authStatus().then(setAuth).catch(ignore("read again on the next sign-out event or launch"));
    window.addEventListener(SIGNED_OUT_EVENT, reread);
    window.addEventListener("focus", reread);
    // Signing in or out in the Settings window: `focus` doesn't fire reliably when moving between
    // the app's own windows, so the other windows hear it as an app event.
    const unlisten = listen(AUTH_CHANGED_EVENT, reread);
    const t = loggedIn ? setInterval(reread, 30_000) : undefined;
    return () => {
      window.removeEventListener(SIGNED_OUT_EVENT, reread);
      window.removeEventListener("focus", reread);
      unlisten.then((off) => off()).catch(() => {});
      clearInterval(t);
    };
  }, [loggedIn]);

  // Labs for the palette: load once the app is ready and whenever sign-in changes.
  useEffect(() => {
    apiQuery<{ labs: { id: string; slug: string; title: string; category: string }[] }>("{ labs(sort: [{ title: ASC }]) { id slug title category } }")
      .then((d) => setPalLabs(d.labs))
      .catch(() => setPalLabs([]));
  }, [auth?.loggedIn]);

  // Labs running or starting right now, shown as their own entries in the sidebar so one is a
  // click away wherever you are. Deploys come from the backend (so they survive a reload); the
  // running set is polled from this machine's workloads.
  const deploying = useDeployingLabs();
  // Ctrl+, opens Settings on Linux and Windows, where the menu bar (and its shortcut) is gone.
  // macOS keeps Cmd+, in the app menu, so it is left to that there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "," && !navigator.userAgent.includes("Mac")) {
        e.preventDefault();
        openSettings().catch(tell("Couldn't open Settings"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // What each busy lab is doing and the step it is at, for a live line under its name.
  const ops = useActiveOperations();
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  // Read again as soon as an operation starts or ends: a lab just shut down otherwise kept its
  // "Running" line until the next poll.
  const busyKey = [...deploying, ...ops.keys()].sort().join(",");
  useEffect(() => {
    let alive = true;
    const read = () =>
      machineWorkloads()
        .then((w) => alive && setRunningIds(new Set(w.map((x) => x.id).filter((id) => id !== "selftest"))))
        .catch(ignore("polled again in a moment"));
    read();
    const t = setInterval(read, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [busyKey]);
  const activeLabs = palLabs
    .filter((l) => deploying.has(l.id) || ops.has(l.id) || runningIds.has(l.id))
    .map((l) => ({ ...l, op: ops.get(l.id) ?? (deploying.has(l.id) ? { labId: l.id, op: "launch" as const, machine: null, step: null } : null) }));

  const paletteCommands: Command[] = [
    { id: "find-lab", label: "Find a lab", hint: "search", icon: Search, keywords: "labs search ctf", run: findALab },
    ...NAV.filter((n) => !n.soon).map((n) => ({
      id: `go-${n.id}`,
      label: `Go to ${n.label}`,
      icon: n.icon,
      keywords: n.label,
      run: () => navigate(n.id),
    })),
    ...palLabs.map((l) => ({
      id: `lab-${l.slug}`,
      label: l.title,
      hint: l.category,
      icon: FlaskConical,
      keywords: `lab ${l.category}`,
      run: () => navigate("labs", l.slug),
    })),
  ];

  function completeOnboarding() {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* ignore */
    }
    setOnboarded(true);
    setTab("labs");
    check();
    // Pick up a sign-in done during onboarding: the shell's auth was read once at mount (before
    // onboarding), so re-read the persisted session, otherwise the app stays "offline" until a
    // restart even though the user just signed in.
    authStatus().then(setAuth).catch(ignore("the sign-in state is read again on the next event"));
  }

  if (!ready) return <div className="h-dvh bg-background" />;
  // Settings runs standalone in its own window: no sidebar, no onboarding, just the screen.
  if (settingsWindow)
    return (
      <SettingsWindowView
        auth={auth}
        onAuthChange={(status) => {
          setAuth(status);
          emit(AUTH_CHANGED_EVENT).catch(() => {});
        }}
      />
    );
  if (!onboarded) return <Onboarding onComplete={completeOnboarding} />;

  const CurrentIcon = NAV.find((n) => n.id === tab)?.icon ?? MonitorCog;

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <CommandPalette key={paletteOpen ? "open" : "closed"} open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      <QuitGuard />
      <LaunchConfirm />
      {/* ---- Sidebar ---- */}
      <aside className="flex w-[14.5rem] shrink-0 flex-col border-r border-border">
        {/* macOS titlebar band inside the column, so the sidebar divider runs to the top of the window */}
        <div data-tauri-drag-region className="h-9 shrink-0" />
        <div data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4">
          <Image src="/logo-mark.svg" alt="" width={20} height={20} className="size-5 pointer-events-none" priority />
          <span className="text-[0.8125rem] font-semibold tracking-tight">Cyber CTF</span>
        </div>

        <button
          onClick={() => navigate("labs")}
          className="mx-3 mb-2 mt-3 flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[0.78125rem] text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground"
        >
          <Search className="size-3.5" />
          <span>Find a lab…</span>
          <kbd className="ml-auto rounded border border-border px-1.5 text-[0.6875rem] text-muted-foreground/70">/</kbd>
        </button>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map((n) => {
            return (
              <div key={n.id}>
                {n.sep && <div className="my-2 h-px bg-border" />}
                <button
                  onClick={() => navigate(n.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[0.4375rem] text-[0.8125rem] transition-colors",
                    tab === n.id ? "bg-[#1a1a1a] text-foreground" : "text-muted-foreground hover:bg-[#141414] hover:text-foreground",
                    n.soon && tab !== n.id && "opacity-55",
                  )}
                >
                  <n.icon className="size-4 shrink-0" />
                  <span className="flex-1 text-left">{n.label}</span>
                  {n.soon && (
                    <span className="rounded border border-border px-1.5 text-[0.5625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                      Soon
                    </span>
                  )}
                </button>
              </div>
            );
          })}

          {activeLabs.length > 0 && (
            <div className="pt-1">
              <div className="my-2 h-px bg-border" />
              {activeLabs.map((l) => (
                <button
                  key={l.id}
                  onClick={() => navigate("labs", l.slug)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[#141414]"
                >
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-md border",
                      l.op ? "border-learn/25 bg-learn/10 text-learn" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-500",
                    )}
                  >
                    {l.op ? <Spinner className="size-3.5" /> : <FlaskConical className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.78125rem] font-medium text-foreground">{l.title}</span>
                    <span className="flex items-center gap-1.5 truncate text-[0.65625rem] text-muted-foreground">
                      {l.op ? (
                        <span className="min-w-0">
                          <span className="block truncate text-learn">{operationLabel(l.op)}</span>
                          {/* The step the operation is at, re-entering as it changes. */}
                          {l.op.step && (
                            <span
                              key={l.op.step}
                              className="animate-fade-in block truncate font-mono text-[0.59375rem] text-muted-foreground/80"
                              title={l.op.step}
                            >
                              {l.op.step}
                            </span>
                          )}
                        </span>
                      ) : (
                        <>
                          {/* A live dot: the lab is up right now, not a stale entry. */}
                          <span className="relative flex size-1.5 shrink-0">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                          </span>
                          Running
                        </>
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="border-t border-border px-3 py-3">
          <Account status={auth} onChange={setAuth} online={!!auth?.loggedIn} onSettings={() => openSettings().catch(tell("Couldn't open Settings"))} />
        </div>
      </aside>

      {/* ---- Main ---- */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div data-tauri-drag-region className="h-9 shrink-0" />
        <div data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <CurrentIcon className="size-4 text-muted-foreground" />
          <span className="text-[0.8125rem] font-medium text-foreground">{TITLES[tab]}</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          <UpdateBanner />
          <div className="mx-auto w-full max-w-[70rem] px-5 py-5">
            <Screen tab={tab} report={report} auth={auth} openLab={openLab} onRefresh={check} onNavigate={navigate} onAuthChange={setAuth} />
          </div>
        </div>
      </main>
    </div>
  );
}

function ComingSoon({ icon, title, description }: { icon: "server" | "cloud" | "sparkles"; title: string; description: string }) {
  return <EmptyState icon={icon} title={`${title} is on the way`} description={description} />;
}

// Settings rendered on its own in the dedicated `settings` window: just the titlebar band and
// the screen. The "set up a hypervisor" link lives in the main window, so onNavigate closes here.
function SettingsWindowView({ auth, onAuthChange }: { auth: AuthStatus | null; onAuthChange: (status: AuthStatus) => void }) {
  const close = () => getCurrentWindow().close().catch(warn("closing the window"));
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <div data-tauri-drag-region className="h-9 shrink-0" />
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Cog className="size-4 text-muted-foreground" />
        <span className="text-[0.8125rem] font-medium text-foreground">Settings</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[70rem] px-5 py-5">
          <SettingsScreen auth={auth} onAuthChange={onAuthChange} onNavigate={close} />
        </div>
      </div>
    </main>
  );
}

function Screen({
  tab,
  report,
  auth,
  openLab,
  onRefresh,
  onNavigate,
  onAuthChange,
}: {
  tab: Tab;
  report: SystemReport | null;
  auth: AuthStatus | null;
  openLab: { slug: string | null; tick: number };
  onRefresh: () => void | Promise<void>;
  onNavigate: (t: Tab, slug?: string) => void;
  onAuthChange: (status: AuthStatus) => void;
}): ReactNode {
  if (tab === "home") return <HomeScreen report={report} auth={auth} onNavigate={onNavigate} />;
  if (tab === "settings") return <SettingsScreen auth={auth} onAuthChange={onAuthChange} onNavigate={onNavigate} />;
  if (tab === "machine")
    return report ? (
      <MachineScreen report={report} onRefresh={onRefresh} onNavigate={onNavigate} />
    ) : (
      <p className="text-sm text-muted-foreground">Checking this machine…</p>
    );
  if (tab === "server") return <ServerScreen onNavigate={onNavigate} />;
  if (tab === "cloud") return <CloudScreen />;
  if (tab === "events")
    return (
      <ComingSoon
        icon="sparkles"
        title="Events"
        description="Join live CTF events where labs are hosted by Cyber CTF: nothing to run on your machine, each participant gets their own lab for the event's duration."
      />
    );
  return report ? (
    <Labs
      loggedIn={auth?.loggedIn ?? false}
      authReady={auth !== null}
      onLogin={async () => onAuthChange(await authLogin())}
      hostArch={report.arch}
      report={report}
      openLab={openLab}
    />
  ) : (
    <p className="text-sm text-muted-foreground">Loading…</p>
  );
}
