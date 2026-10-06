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
import { apiQuery, authLogin, authStatus, machineWorkloads, systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { useDeployingLabs } from "@/lib/deploy-store";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

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
  { id: "settings", label: "Settings", icon: Cog, sep: true },
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A light lab list for the command palette (jump straight to a lab), refreshed on auth change.
  const [palLabs, setPalLabs] = useState<{ id: string; slug: string; title: string; category: string }[]>([]);

  const check = () =>
    systemCheck()
      .then(setReport)
      .catch(() => setReport(null));
  useEffect(() => {
    check();
    authStatus()
      .then(setAuth)
      .catch(() => setAuth({ loggedIn: false, name: null, email: null }));
    try {
      // Reads a per-machine flag once on mount (localStorage isn't available during render).
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const read = () =>
      machineWorkloads()
        .then((w) => alive && setRunningIds(new Set(w.map((x) => x.id).filter((id) => id !== "selftest"))))
        .catch(() => {});
    read();
    const t = setInterval(read, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const activeLabs = palLabs
    .filter((l) => deploying.has(l.id) || runningIds.has(l.id))
    .map((l) => ({ ...l, deploying: deploying.has(l.id) }));

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
    authStatus()
      .then(setAuth)
      .catch(() => {});
  }

  if (!ready) return <div className="h-dvh bg-background" />;
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
              <p className="px-2.5 pb-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/60">Running</p>
              {activeLabs.map((l) => (
                <button
                  key={l.id}
                  onClick={() => navigate("labs", l.slug)}
                  title={l.deploying ? "Starting" : "Running"}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[0.4375rem] text-[0.8125rem] text-muted-foreground transition-colors hover:bg-[#141414] hover:text-foreground"
                >
                  {l.deploying ? (
                    <Spinner className="size-4 shrink-0" />
                  ) : (
                    <span className="size-4 shrink-0 self-center">
                      <span className="block size-2 translate-x-1 translate-y-1 rounded-full bg-emerald-500" />
                    </span>
                  )}
                  <span className="flex-1 truncate text-left">{l.title}</span>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="space-y-2.5 border-t border-border px-3.5 py-3">
          <div
            className="flex items-center gap-2 px-0.5 text-[0.71875rem] text-muted-foreground"
            title={auth?.loggedIn ? "Signed in: labs you launch from the website run on this machine." : "Sign in so labs launched from the website run on this machine."}
          >
            <span className={cn("size-1.5 rounded-full", auth?.loggedIn ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            {auth?.loggedIn ? "This machine · online" : "This machine · offline"}
          </div>
          <Account status={auth} onChange={setAuth} />
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
      onLogin={async () => onAuthChange(await authLogin())}
      hostArch={report.arch}
      report={report}
      openLab={openLab}
    />
  ) : (
    <p className="text-sm text-muted-foreground">Loading…</p>
  );
}
