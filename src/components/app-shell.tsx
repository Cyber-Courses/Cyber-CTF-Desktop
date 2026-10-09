"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { PortModePrompt } from "@/features/labs/port-mode-prompt";
import { Onboarding } from "@/features/onboarding/onboarding";
import { UpdateBanner } from "@/components/update-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { apiQuery, authLogin, authStatus, machineWorkloads, openSettings, systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { operationLabel, SIGNED_OUT_EVENT, useActiveOperations, useDeployingLabs } from "@/lib/deploy-store";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-pill";
import { Toaster } from "@/components/ui/toaster";
import { useAttackBoxAutoStart } from "@/features/labs/attack-box-auto";
import { CtfMark } from "@/components/brand/mark";
import { engineName } from "@/features/machine/setup-steps/engines";
import { PROVIDER_LABELS } from "@/features/machine/hypervisors";
import { getVersion } from "@tauri-apps/api/app";
import { cn } from "@/lib/utils";
import { ignore, tell, warn } from "@/lib/failure";
import { useLabLinks } from "@/lib/deep-link";
import { useLabState } from "@/features/labs/lab-store";
import { AUTH_CHANGED_EVENT, NAVIGATE_EVENT, REPLAY_ONBOARDING_EVENT, showInMainWindow } from "@/lib/app-events";
import { Button } from "@/components/ui/button";
import { installDevMock } from "@/lib/dev-mock";
import { useAppearanceSync } from "@/lib/appearance";
import { translate, useT } from "@/lib/i18n";

// Development only: ?mock in a plain browser answers the Tauri commands with sample data.
installDevMock();

/** Broadcast to every window when the session changes in one of them. */

type Tab = "home" | "labs" | "machine" | "setup" | "server" | "cloud" | "events" | "settings";

const ONBOARDED_KEY = "cyberctf.onboarded";

// Grouped: the lab area (what you run), then the setup area (the compute it runs on), then
// Settings. `sep` draws a divider before the item, at each group boundary. Labels are the
// screens' titles (shell.tabs).
const NAV: { id: Tab; icon: LucideIcon; soon?: boolean; sep?: boolean }[] = [
  { id: "home", icon: LayoutDashboard },
  { id: "labs", icon: FlaskConical },
  { id: "events", icon: CalendarDays, soon: true },
  { id: "machine", icon: MonitorCog, sep: true },
  { id: "server", icon: Server },
  { id: "cloud", icon: Cloud },
];

export function AppShell() {
  useAppearanceSync();
  const t = useT();
  const title = (tab: Tab) => t(`shell.tabs.${tab}`);
  const [tab, setTab] = useState<Tab>("home");
  const [openLab, setOpenLab] = useState<{ slug: string | null; tick: number }>({ slug: null, tick: 0 });
  const [report, setReport] = useState<SystemReport | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [onboarded, setOnboarded] = useState(true);
  const [ready, setReady] = useState(false);
  // This webview is the dedicated Settings window (opened by `open_settings` with ?window=settings).
  const [settingsWindow, setSettingsWindow] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The lab page open in Labs, for the breadcrumb (null on the list and other screens).
  const [labTitle, setLabTitle] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [isMac, setIsMac] = useState(true);
  // A light lab list for the command palette (jump straight to a lab), refreshed on auth change.
  const [palLabs, setPalLabs] = useState<{ id: string; slug: string; title: string; category: string }[]>([]);

  // The machine check failed (and no earlier one succeeded): the screens that need it say so
  // with a retry instead of "Checking this machine…" forever.
  const [checkError, setCheckError] = useState<string | null>(null);
  const lastCheck = useRef(0);
  const check = () => {
    lastCheck.current = Date.now();
    return systemCheck()
      .then((r) => {
        setReport(r);
        setCheckError(null);
      })
      .catch((e) => setCheckError(String(e)));
  };
  // Checked again when the window comes back (at most every 15 s): Docker started from a
  // terminal, or an engine installed meanwhile, shows up without a restart.
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastCheck.current > 15_000) void check();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    try {
      // Reads the window marker once on mount (window isn't available during render).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSettingsWindow(new URLSearchParams(window.location.search).get("window") === "settings");
    } catch {
      /* ignore */
    }
    check();
    getVersion().then(setVersion).catch(ignore("no version outside the app"));
    setIsMac(navigator.userAgent.includes("Mac"));
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

  // Asked from the Settings window: switch screens, or show the onboarding again. Brought to the
  // front, since the request came from another window.
  useEffect(() => {
    if (!ready || settingsWindow) return;
    const toFront = () => getCurrentWindow().setFocus().catch(ignore("the window manager keeps focus where it is"));
    const nav = listen<string>(NAVIGATE_EVENT, (e) => {
      if (NAV.some((n) => n.id === e.payload)) navigate(e.payload as Tab);
      void toFront();
    });
    const replay = listen(REPLAY_ONBOARDING_EVENT, () => {
      setOnboarded(false);
      void toFront();
    });
    return () => {
      nav.then((off) => off()).catch(ignore("the listener was never set up"));
      replay.then((off) => off()).catch(ignore("the listener was never set up"));
    };
  }, [ready, settingsWindow]);

  // A cyberctf://labs/<slug> link (the one that opened the app, or one opened since) shows that
  // lab, whatever screen is open. Not in the Settings window: the main window takes it.
  useLabLinks((slug) => navigate("labs", slug), ready && !settingsWindow);

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
      unlisten.then((off) => off()).catch(ignore("the listener was never set up"));
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
        openSettings().catch(tell(translate("shell.failures.openSettings")));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // What each busy lab is doing and the step it is at, for a live line under its name.
  const ops = useActiveOperations();
  // Main window only: Settings runs this shell too, and two windows must not both start a box.
  useAttackBoxAutoStart(ops, ready && !settingsWindow);
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
  // A lab's own status, once known, has the last word over the workload scan: the scan counts
  // any VM a lab left behind (a half-started VM lab), so the sidebar said "Running" while the
  // Overview, from the same statuses, counted one lab fewer.
  const statuses = useLabState("statuses");
  const scanSaysRunning = (id: string) => runningIds.has(id) && (statuses[id] ? statuses[id].running : true);
  const activeLabs = palLabs
    .filter((l) => deploying.has(l.id) || ops.has(l.id) || scanSaysRunning(l.id))
    .map((l) => ({ ...l, op: ops.get(l.id) ?? (deploying.has(l.id) ? { labId: l.id, op: "launch" as const, machine: null, step: null } : null) }));

  const paletteCommands: Command[] = [
    {
      id: "find-lab",
      label: t("shell.palette.findLab"),
      hint: "/",
      icon: Search,
      keywords: t("shell.palette.findLabKeywords"),
      group: t("shell.palette.groups.actions"),
      run: findALab,
    },
    {
      id: "settings",
      label: t("shell.palette.openSettings"),
      icon: Cog,
      keywords: t("shell.palette.openSettingsKeywords"),
      group: t("shell.palette.groups.actions"),
      run: () => void openSettings().catch(tell(t("shell.failures.openSettings"))),
    },
    ...NAV.filter((n) => !n.soon).map((n) => ({
      id: `go-${n.id}`,
      label: t("shell.palette.goTo", { screen: title(n.id) }),
      icon: n.icon,
      keywords: title(n.id),
      group: t("shell.palette.groups.screens"),
      run: () => navigate(n.id),
    })),
    ...palLabs.map((l) => ({
      id: `lab-${l.slug}`,
      label: l.title,
      hint: l.category,
      icon: FlaskConical,
      keywords: t("shell.palette.labKeywords", { category: l.category }),
      group: t("shell.palette.groups.labs"),
      run: () => navigate("labs", l.slug),
    })),
  ];

  // Signed in or out here: the Settings window (if open) hears it too.
  function authChanged(status: AuthStatus) {
    setAuth(status);
    emit(AUTH_CHANGED_EVENT).catch(warn("Couldn't tell the other windows about the sign-in"));
  }

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
  if (settingsWindow) return <SettingsWindowView auth={auth} onAuthChange={authChanged} />;
  // With its own Toaster: `tell()` shows errors as toasts while the window has focus.
  if (!onboarded)
    return (
      <>
        <Onboarding onComplete={completeOnboarding} />
        <Toaster />
      </>
    );

  // Breadcrumb: where you are. A lab page shows "Labs / <lab>".
  const crumbs = tab === "labs" && labTitle ? [title("labs"), labTitle] : [tab === "settings" ? title("settings") : t("shell.header.thisMachine"), title(tab)];
  // `docker --version` reads "Docker version 29.5.3, build d1c06ef": the number is enough next to the engine's name.
  const dockerVersion = report?.docker.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? null;
  const engine = report?.dockerRunning && report.dockerEngine ? `${engineName(report.dockerEngine)}${dockerVersion ? ` ${dockerVersion}` : ""}` : null;
  const hypervisor = report?.vmProviders.find((p) => !p.remote && p.available && p.hypervisor !== false);

  return (
    // `overflow-clip`, not `hidden`: a hidden box can still be scrolled (focus, scrollIntoView,
    // a wheel over the sidebar), which shifted the whole window up under the titlebar.
    <div className="flex h-dvh overflow-clip bg-background text-foreground">
      <CommandPalette key={paletteOpen ? "open" : "closed"} open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      <QuitGuard />
      <LaunchConfirm />
      <PortModePrompt />
      <Toaster />
      {/* ---- Sidebar ---- */}
      <aside className="flex w-[14.5rem] shrink-0 flex-col border-r border-border bg-card">
        {/* macOS titlebar band (traffic lights) inside the column, so the divider runs to the top.
            Linux and Windows keep their own title bar, so there it would only be a blank strip. */}
        {isMac && <div data-tauri-drag-region className="h-10 shrink-0" />}
        <div data-tauri-drag-region className={`flex items-center gap-2.5 px-3.5 pb-3 ${isMac ? "" : "pt-4"}`}>
          <CtfMark className="pointer-events-none size-[1.35rem]" />
          <span className="pointer-events-none text-[0.875rem] font-semibold tracking-tight">Cyber CTF</span>
          {version && <span className="pointer-events-none ml-auto font-mono text-[0.625rem] text-faint">v{version}</span>}
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mx-2.5 mb-2.5 flex h-8 items-center justify-between rounded-sm bg-glass px-2.5 text-[0.75rem] text-faint shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:text-muted-foreground"
        >
          <span className="flex items-center gap-2">
            <Search className="size-3.5" /> {t("shell.sidebar.find")}
          </span>
          <kbd className="kbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>

        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5">
          {NAV.map((n) => (
            <div key={n.id}>
              {n.sep && <div className="mx-1.5 my-2 h-px bg-border" />}
              <NavItem icon={n.icon} active={tab === n.id} dim={n.soon && tab !== n.id} onClick={() => navigate(n.id)}>
                {title(n.id)}
                {n.soon ? (
                  <span className="ml-auto font-mono text-[0.625rem] text-faint">{t("shell.sidebar.soon")}</span>
                ) : n.id === "labs" && palLabs.length > 0 ? (
                  <span className="ml-auto font-mono text-[0.6875rem] text-faint">{palLabs.length}</span>
                ) : null}
              </NavItem>
            </div>
          ))}

          {activeLabs.length > 0 && (
            <>
              <div className="section-label px-2 pt-4 pb-1.5">{t("shell.sidebar.running")}</div>
              {activeLabs.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => navigate("labs", l.slug)}
                  className="flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-glass"
                >
                  <StatusDot tone={l.op ? "warn" : "ok"} pulse={!!l.op} className="mt-[0.4rem]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.8125rem] text-foreground">{l.title}</span>
                    {l.op ? (
                      <>
                        <span className="block truncate font-mono text-[0.625rem] text-warning">{operationLabel(l.op)}</span>
                        {/* The step the operation is at, re-entering as it changes. */}
                        {l.op.step && (
                          <span key={l.op.step} className="animate-fade-in block truncate font-mono text-[0.625rem] text-faint" title={l.op.step}>
                            {l.op.step}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="block truncate font-mono text-[0.625rem] text-faint">{t("shell.sidebar.labRunning")}</span>
                    )}
                  </span>
                </button>
              ))}
            </>
          )}

          <div className="flex-1" />
          <NavItem icon={Cog} active={false} onClick={() => openSettings().catch(tell(t("shell.failures.openSettings")))}>
            {title("settings")}
            <span className="ml-auto font-mono text-[0.625rem] text-faint">{isMac ? "⌘," : "Ctrl ,"}</span>
          </NavItem>
        </nav>

        <div className="mt-1 border-t border-border px-2.5 py-2.5">
          <Account status={auth} onChange={authChanged} online={!!auth?.loggedIn} />
        </div>
      </aside>

      {/* ---- Main ---- */}
      <main className="flex min-w-0 flex-1 flex-col overflow-clip">
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-6 text-[0.8125rem] text-faint">
          {crumbs.map((c, i) =>
            i === crumbs.length - 1 ? (
              <b key={i} className="pointer-events-none truncate font-medium text-foreground">
                {c}
              </b>
            ) : (
              <span key={i} className="pointer-events-none flex items-center gap-2">
                {c}
                <span>/</span>
              </span>
            ),
          )}
          <span className="pointer-events-none ml-auto flex items-center gap-2 font-mono text-[0.6875rem]">
            {report ? (
              <>
                <StatusDot tone={report.dockerRunning ? "ok" : "warn"} />
                {engine ?? t("shell.header.dockerNotRunning")}
                {hypervisor && <span> · {PROVIDER_LABELS[hypervisor.provider] ?? hypervisor.provider}</span>}
              </>
            ) : checkError ? (
              <>
                <StatusDot tone="fail" /> {t("shell.header.checkFailed")}
              </>
            ) : (
              <>
                <StatusDot tone="muted" /> {t("shell.header.checking")}
              </>
            )}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          <UpdateBanner />
          <div className="mx-auto w-full max-w-[72rem] px-7 pt-7 pb-10">
            <Screen
              tab={tab}
              report={report}
              checkError={checkError}
              auth={auth}
              openLab={openLab}
              onRefresh={check}
              onNavigate={navigate}
              onAuthChange={setAuth}
              onLabChange={setLabTitle}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

/** One sidebar entry: 2rem high, icon then label; the current one sits on a glass fill. */
function NavItem({ icon: I, active, dim, onClick, children }: { icon: LucideIcon; active: boolean; dim?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-[0.8125rem] transition-colors",
        active ? "bg-glass-2 text-foreground shadow-[inset_0_0_0_1px_var(--border)]" : "text-muted-foreground hover:bg-glass hover:text-foreground",
        dim && "opacity-60",
      )}
    >
      <I className="size-4 shrink-0 opacity-85" />
      {children}
    </button>
  );
}

function ComingSoon({ icon, title, description }: { icon: "server" | "cloud" | "sparkles"; title: string; description: string }) {
  const t = useT();
  return <EmptyState icon={icon} title={t("shell.screen.comingSoon", { title })} description={description} />;
}

// Settings rendered on its own in the dedicated `settings` window: just the titlebar band and
// the screen. The "set up a hypervisor" link shows the Machine screen in the main window.
function SettingsWindowView({ auth, onAuthChange }: { auth: AuthStatus | null; onAuthChange: (status: AuthStatus) => void }) {
  // The titlebar band stands in for macOS's hidden title; elsewhere the window's own title bar
  // already says "Settings".
  const t = useT();
  const isMac = useSyncExternalStore(
    () => () => {},
    () => navigator.userAgent.includes("Mac"),
    () => false,
  );
  return (
    <main className="flex h-dvh flex-col overflow-clip bg-background text-foreground">
      <Toaster />
      {isMac && (
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center justify-center border-b border-border text-[0.8125rem] font-medium">
          <span className="pointer-events-none">{t("shell.tabs.settings")}</span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[52rem] px-7 pt-7 pb-10">
          <SettingsScreen auth={auth} onAuthChange={onAuthChange} onNavigate={showInMainWindow} />
        </div>
      </div>
    </main>
  );
}

function Screen({
  tab,
  report,
  checkError,
  auth,
  openLab,
  onRefresh,
  onNavigate,
  onAuthChange,
  onLabChange,
}: {
  tab: Tab;
  report: SystemReport | null;
  checkError: string | null;
  auth: AuthStatus | null;
  openLab: { slug: string | null; tick: number };
  onRefresh: () => void | Promise<void>;
  onNavigate: (t: Tab, slug?: string) => void;
  onAuthChange: (status: AuthStatus) => void;
  onLabChange: (title: string | null) => void;
}): ReactNode {
  const t = useT();
  // Shown where the machine check is needed and hasn't answered: a retry when it failed.
  const waiting = (what: string) =>
    checkError ? (
      <EmptyState
        icon="alert"
        title={t("shell.screen.checkFailed")}
        description={checkError}
        action={
          <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
            {t("shell.screen.tryAgain")}
          </Button>
        }
      />
    ) : (
      <p className="flex items-center gap-2.5 text-[0.8125rem] text-muted-foreground">
        <Spinner className="size-3.5" /> {what}
      </p>
    );
  if (tab === "home") return <HomeScreen report={report} auth={auth} onNavigate={onNavigate} />;
  if (tab === "settings") return <SettingsScreen auth={auth} onAuthChange={onAuthChange} onNavigate={onNavigate} />;
  if (tab === "machine") return report ? <MachineScreen report={report} onRefresh={onRefresh} onNavigate={onNavigate} /> : waiting(t("shell.screen.checking"));
  if (tab === "server") return <ServerScreen onNavigate={onNavigate} />;
  if (tab === "cloud") return <CloudScreen />;
  if (tab === "events") return <ComingSoon icon="sparkles" title={t("shell.tabs.events")} description={t("shell.screen.eventsDescription")} />;
  return report ? (
    <Labs
      loggedIn={auth?.loggedIn ?? false}
      authReady={auth !== null}
      onLogin={async () => onAuthChange(await authLogin())}
      hostArch={report.arch}
      report={report}
      openLab={openLab}
      onDetailChange={onLabChange}
    />
  ) : (
    waiting(t("shell.screen.loading"))
  );
}
