"use client";

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Eraser, FlaskConical, Info, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentInfo, systemCheck, type AgentInfo, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { AboutSection } from "@/features/settings/about-section";
import { AccountSection } from "@/features/settings/account-section";
import { AttackBoxRows } from "@/features/settings/attack-box-rows";
import { CleanupSection } from "@/features/settings/cleanup-section";
import { HypervisorRow } from "@/features/settings/hypervisor-row";
import { Section, useSavedFlash } from "@/features/settings/settings-layout";

export const ONBOARDED_KEY = "cyberctf.onboarded";

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
  const recheck = () =>
    systemCheck()
      .then(setReport)
      .catch(() => {});

  // The agent registers once signed in, so re-read it whenever auth changes.
  useEffect(() => {
    if (auth?.loggedIn)
      agentInfo()
        .then(setAgent)
        .catch(() => setAgent(null));
  }, [auth?.loggedIn]);

  // One section at a time, picked from a rail: a setting is one click away instead of somewhere
  // down a long scroll, and the window fits its content.
  const tabs = [
    { id: "account", label: "Account", icon: UserRound },
    { id: "labs", label: "Labs", icon: FlaskConical },
    { id: "maintenance", label: "Maintenance", icon: Eraser },
    { id: "about", label: "About", icon: Info },
  ] as const;
  type Tab = (typeof tabs)[number]["id"];
  const [tab, setTab] = useState<Tab>("account");

  return (
    <div className="mx-auto flex max-w-[47.5rem] gap-6 pb-10">
      <nav aria-label="Settings sections" className="w-40 shrink-0 space-y-0.5 pt-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] transition-colors",
              tab === t.id ? "bg-foreground/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground",
            )}
          >
            <t.icon className="size-4 shrink-0" /> {t.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-9">
        {tab === "account" && <AccountSection auth={auth} agent={auth?.loggedIn ? agent : null} onAuthChange={onAuthChange} />}

        {tab === "labs" && (
          <Section title="Labs" description="How labs start on this machine. Saved on this computer only." saved={labsSaved}>
            <AttackBoxRows onSaved={flashLabs} />
            <HypervisorRow report={report} onSaved={flashLabs} onNavigate={onNavigate} onRefresh={recheck} />
          </Section>
        )}

        {tab === "maintenance" && <CleanupSection />}

        {tab === "about" && <AboutSection version={version} report={report} agent={auth?.loggedIn ? agent : null} />}
      </div>
    </div>
  );
}
