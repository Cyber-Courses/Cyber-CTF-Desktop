"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { Account } from "@/components/Account";
import { Labs } from "@/components/Labs";
import { HomeScreen } from "@/components/screens/home-screen";
import { MachineScreen } from "@/components/screens/machine-screen";
import { SettingsScreen } from "@/components/screens/settings-screen";
import { systemCheck, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "home" | "labs" | "machine" | "settings";

function Icon({ name, className }: { name: Tab; className?: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} {...common} aria-hidden>
      {name === "home" && <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" /></>}
      {name === "labs" && <><path d="M9 3h6" /><path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" /><path d="M7 15h10" /></>}
      {name === "machine" && <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>}
      {name === "settings" && <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>}
    </svg>
  );
}

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
        <div className="flex items-center gap-2.5 px-5 py-5">
          <Image src="/logo-mark.svg" alt="" width={24} height={24} className="size-6" priority />
          <span className="text-sm font-semibold tracking-tight">Cyber CTF</span>
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
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-10">
          <Screen tab={tab} report={report} auth={auth} onRefresh={check} onNavigate={setTab} />
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
