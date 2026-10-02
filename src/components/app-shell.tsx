"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { Account } from "@/components/Account";
import { Labs } from "@/components/Labs";
import { HomeScreen } from "@/components/screens/home-screen";
import { MachineScreen } from "@/components/screens/machine-screen";
import { SettingsScreen } from "@/components/screens/settings-screen";
import { UpdateBanner } from "@/components/update-banner";
import { Icon } from "@/components/ui/icon";
import { systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "home" | "labs" | "machine" | "settings";

export function AppShell() {
  const [tab, setTab] = useState<Tab>("home");
  const [report, setReport] = useState<SystemReport | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  const check = () => systemCheck().then(setReport).catch(() => setReport(null));
  useEffect(() => {
    check();
  }, []);

  const nav: { id: Tab; label: string }[] = [
    { id: "home", label: "Home" },
    { id: "labs", label: "Labs" },
    { id: "machine", label: "This machine" },
    { id: "settings", label: "Settings" },
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
              )}
            >
              <Icon name={n.id} />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-border px-4 py-3">
          <Account onChange={setAuth} />
        </div>
      </aside>

      {/* Content */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Full-width draggable title-bar strip (no native bar with Overlay style). */}
        <div data-tauri-drag-region className="h-8 shrink-0" />
        <div className="flex-1 overflow-y-auto">
          <UpdateBanner />
          <div className="mx-auto max-w-3xl px-8 pb-10 pt-2">
            <Screen tab={tab} report={report} auth={auth} onRefresh={check} onNavigate={setTab} />
          </div>
        </div>
      </main>
    </div>
  );
}

function Screen({ tab, report, auth, onRefresh, onNavigate }: { tab: Tab; report: SystemReport | null; auth: AuthStatus | null; onRefresh: () => void | Promise<void>; onNavigate: (t: Tab) => void }): ReactNode {
  if (tab === "home") return <HomeScreen report={report} auth={auth} onNavigate={onNavigate} />;
  if (tab === "settings") return <SettingsScreen auth={auth} />;
  if (tab === "machine") {
    return report ? <MachineScreen report={report} onRefresh={onRefresh} /> : <p className="text-sm text-muted-foreground">Checking this machine…</p>;
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Labs</h1>
        <p className="mt-1 text-sm text-muted-foreground">Run a lab on this machine, or launch it from the website.</p>
      </div>
      {report && <Labs loggedIn={auth?.loggedIn ?? false} hostArch={report.arch} />}
    </div>
  );
}
