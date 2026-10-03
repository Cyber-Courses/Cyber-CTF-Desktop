"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { Account } from "@/components/Account";
import { Labs } from "@/components/Labs";
import { HomeScreen } from "@/components/screens/home-screen";
import { MachineScreen } from "@/components/screens/machine-screen";
import { SettingsScreen } from "@/components/screens/settings-screen";
import { Onboarding } from "@/components/onboarding/onboarding";
import { UpdateBanner } from "@/components/update-banner";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, type IconName } from "@/components/ui/icon";
import { systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "home" | "labs" | "machine" | "homelab" | "cloud" | "settings";

const ONBOARDED_KEY = "cyberctf.onboarded";

export function AppShell() {
  const [tab, setTab] = useState<Tab>("home");
  const [report, setReport] = useState<SystemReport | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  // First run shows the onboarding wizard. Default to onboarded on storage errors so a
  // broken localStorage never traps the user on the wizard.
  const [onboarded, setOnboarded] = useState(true);
  const [ready, setReady] = useState(false);

  const check = () => systemCheck().then(setReport).catch(() => setReport(null));
  useEffect(() => {
    check();
    try {
      setOnboarded(localStorage.getItem(ONBOARDED_KEY) === "1");
    } catch {
      setOnboarded(true);
    }
    setReady(true);
  }, []);

  function completeOnboarding() {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* ignore - we still advance past onboarding for this session */
    }
    setOnboarded(true);
    setTab("labs");
    check();
  }

  // Avoid a flash of the shell before we know whether to onboard.
  if (!ready) return <div className="h-dvh bg-background" />;
  if (!onboarded) return <Onboarding onComplete={completeOnboarding} />;

  const nav: { id: Tab; label: string; icon: IconName; soon?: boolean }[] = [
    { id: "home", label: "Home", icon: "home" },
    { id: "labs", label: "Labs", icon: "labs" },
    { id: "machine", label: "Machine", icon: "machine" },
    { id: "homelab", label: "Home lab", icon: "server", soon: true },
    { id: "cloud", label: "Cloud", icon: "cloud", soon: true },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        {/* Draggable strip under the macOS traffic lights (Overlay title bar). */}
        <div data-tauri-drag-region className="h-8 shrink-0" />
        <div data-tauri-drag-region className="flex items-center gap-2.5 px-5 pb-4 pt-1">
          <Image src="/logo-mark.svg" alt="" width={24} height={24} className="size-6 pointer-events-none" priority />
          <span className="pointer-events-none text-sm font-semibold tracking-tight">Cyber CTF</span>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {nav.map((n) => (
            <button
              key={n.id}
              onClick={() => setTab(n.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                tab === n.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                n.soon && tab !== n.id && "opacity-55",
              )}
            >
              <Icon name={n.icon} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.soon && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">Soon</span>
              )}
            </button>
          ))}
        </nav>
        <div className="space-y-3 border-t border-border px-4 py-3">
          <div
            className="flex items-center gap-2 px-1 text-xs"
            title={auth?.loggedIn ? "Labs launched from the website run on this machine." : "Sign in so labs launched from the website can run here."}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", auth?.loggedIn ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            <span className="text-muted-foreground">{auth?.loggedIn ? "Launcher online" : "Launcher offline"}</span>
          </div>
          <Account onChange={setAuth} />
        </div>
      </aside>

      {/* Content */}
      <main className="relative flex flex-1 flex-col overflow-hidden bg-background">
        {/* Decorative canvas: faint guide grid + soft top glow (matches the website). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid opacity-70" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-glow" />
        {/* Full-width draggable title-bar strip (no native bar with Overlay style). */}
        <div data-tauri-drag-region className="relative z-10 h-8 shrink-0" />
        <div className="relative z-10 flex-1 overflow-y-auto">
          <UpdateBanner />
          <div className="mx-auto w-full max-w-6xl px-8 pb-12 pt-3">
            <Screen tab={tab} report={report} auth={auth} onRefresh={check} onNavigate={setTab} />
          </div>
        </div>
      </main>
    </div>
  );
}

function ComingSoon({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <Badge variant="accent">Coming soon</Badge>
      </div>
      <EmptyState icon={icon} title={`${title} is on the way`} description={description} />
    </div>
  );
}

function Screen({ tab, report, auth, onRefresh, onNavigate }: { tab: Tab; report: SystemReport | null; auth: AuthStatus | null; onRefresh: () => void | Promise<void>; onNavigate: (t: Tab) => void }): ReactNode {
  if (tab === "home") return <HomeScreen report={report} auth={auth} onNavigate={onNavigate} />;
  if (tab === "settings") return <SettingsScreen auth={auth} />;
  if (tab === "machine") {
    return report ? <MachineScreen report={report} onRefresh={onRefresh} /> : <p className="text-sm text-muted-foreground">Checking this machine…</p>;
  }
  if (tab === "homelab") {
    return <ComingSoon icon="server" title="Home lab" description="Connect your own servers (VMware ESXi, Proxmox) and run heavier VM labs on dedicated hardware." />;
  }
  if (tab === "cloud") {
    return <ComingSoon icon="cloud" title="Cloud" description="Spin up labs in the cloud with zero local setup, then open them right here." />;
  }
  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Labs</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Run a lab on this machine, or launch it from the website, it runs here.</p>
      </div>
      {report && <Labs loggedIn={auth?.loggedIn ?? false} hostArch={report.arch} />}
    </div>
  );
}
