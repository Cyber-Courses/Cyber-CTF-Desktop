"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, Cloud, Cog, FlaskConical, Globe, LayoutDashboard, type LucideIcon, MonitorCog, Search, Server } from "lucide-react";
import { Account } from "@/features/account/account";
import { Labs } from "@/features/labs/labs-screen";
import { HomeScreen } from "@/features/home/home-screen";
import { MachineScreen } from "@/features/machine/machine-screen";
import { ServerScreen } from "@/features/servers/servers-screen";
import { CloudScreen } from "@/features/cloud/cloud-screen";
import { HostedScreen } from "@/features/hosted/hosted-screen";
import { SettingsScreen } from "@/features/settings/settings-screen";
import { Onboarding } from "@/features/onboarding/onboarding";
import { UpdateBanner } from "@/components/update-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { authStatus, systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "home" | "labs" | "machine" | "setup" | "server" | "cloud" | "hosted" | "events" | "settings";

const ONBOARDED_KEY = "cyberctf.onboarded";

const NAV: { id: Tab; label: string; icon: LucideIcon; soon?: boolean }[] = [
  { id: "home", label: "Overview", icon: LayoutDashboard },
  { id: "labs", label: "Labs", icon: FlaskConical },
  { id: "machine", label: "Machine", icon: MonitorCog },
  { id: "server", label: "Servers", icon: Server },
  { id: "cloud", label: "Cloud", icon: Cloud },
  { id: "hosted", label: "Hosted", icon: Globe, soon: true },
  { id: "events", label: "Events", icon: CalendarDays, soon: true },
  { id: "settings", label: "Settings", icon: Cog },
];

const TITLES: Record<Tab, string> = {
  home: "Overview",
  labs: "Labs",
  machine: "Machine",
  setup: "Setup",
  server: "Servers",
  cloud: "Cloud",
  hosted: "Hosted",
  events: "Events",
  settings: "Settings",
};

export function AppShell() {
  const [tab, setTab] = useState<Tab>("home");
  const [openLab, setOpenLab] = useState<string | null>(null);
  const [report, setReport] = useState<SystemReport | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [onboarded, setOnboarded] = useState(true);
  const [ready, setReady] = useState(false);

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
      setOpenLab(null);
      return;
    }
    setTab(next);
    setOpenLab(slug ?? null);
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
  }

  if (!ready) return <div className="h-dvh bg-background" />;
  if (!onboarded) return <Onboarding onComplete={completeOnboarding} />;

  const CurrentIcon = NAV.find((n) => n.id === tab)?.icon ?? MonitorCog;

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
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
          {NAV.map((n, i) => {
            const prevSoon = NAV[i - 1]?.soon;
            const needSep = (n.soon && !prevSoon) || (!n.soon && prevSoon);
            return (
              <div key={n.id}>
                {needSep && <div className="my-2 h-px bg-border" />}
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
        </nav>

        <div className="space-y-2.5 border-t border-border px-3.5 py-3">
          <div
            className="flex items-center gap-2 px-0.5 text-[0.71875rem] text-muted-foreground"
            title={auth?.loggedIn ? "Labs launched from the website run on this machine." : "Sign in so website launches run here."}
          >
            <span className={cn("size-1.5 rounded-full", auth?.loggedIn ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            {auth?.loggedIn ? "Launcher online" : "Launcher offline"}
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
  openLab: string | null;
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
  if (tab === "hosted") return <HostedScreen onNavigate={onNavigate} />;
  if (tab === "events")
    return (
      <ComingSoon
        icon="sparkles"
        title="Events"
        description="Join live CTF events where labs are hosted by Cyber CTF: nothing to run on your machine, each participant gets their own lab for the event's duration."
      />
    );
  return report ? (
    <Labs loggedIn={auth?.loggedIn ?? false} hostArch={report.arch} report={report} openSlug={openLab} />
  ) : (
    <p className="text-sm text-muted-foreground">Loading…</p>
  );
}
