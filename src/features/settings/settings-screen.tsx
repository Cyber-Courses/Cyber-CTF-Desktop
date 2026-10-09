"use client";

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Eraser, FlaskConical, Info, Palette, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentInfo, systemCheck, type AgentInfo, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { AboutSection } from "@/features/settings/about-section";
import { AccountSection } from "@/features/settings/account-section";
import { AppearanceSection } from "@/features/settings/appearance-section";
import { AttackBoxRows } from "@/features/settings/attack-box-rows";
import { LabPortsRow } from "@/features/settings/lab-ports-row";
import { CleanupSection } from "@/features/settings/cleanup-section";
import { HypervisorRow } from "@/features/settings/hypervisor-row";
import { Section, useSavedFlash } from "@/features/settings/settings-layout";
import { warn } from "@/lib/failure";

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
  const recheck = () => systemCheck().then(setReport).catch(warn("system check"));

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
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "labs", label: "Labs", icon: FlaskConical },
    { id: "maintenance", label: "Maintenance", icon: Eraser },
    { id: "about", label: "About", icon: Info },
  ] as const;
  type Tab = (typeof tabs)[number]["id"];
  const [tab, setTab] = useState<Tab>("account");

  return (
    <div className="mx-auto flex max-w-[47.5rem] gap-8 pb-10">
      <nav aria-label="Settings sections" className="w-44 shrink-0 space-y-0.5 pt-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-[0.8125rem] transition-colors",
              tab === t.id ? "bg-glass-2 text-foreground shadow-[inset_0_0_0_1px_var(--border)]" : "text-muted-foreground hover:bg-glass hover:text-foreground",
            )}
          >
            <t.icon className="size-4 shrink-0 opacity-85" /> {t.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-9">
        {tab === "account" && <AccountSection auth={auth} agent={auth?.loggedIn ? agent : null} onAuthChange={onAuthChange} />}

        {tab === "appearance" && <AppearanceSection />}

        {tab === "labs" && (
          <Section title="Labs" description="How labs start on this machine. Saved on this computer only." saved={labsSaved}>
            <LabPortsRow onSaved={flashLabs} />
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
