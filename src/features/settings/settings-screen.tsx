"use client";

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { agentInfo, systemCheck, type AgentInfo, type AuthStatus, type SystemReport } from "@/lib/tauri";
import { AboutSection } from "@/features/settings/about-section";
import { AccountSection } from "@/features/settings/account-section";
import { AttackBoxRows } from "@/features/settings/attack-box-rows";
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

  // The agent registers once signed in, so re-read it whenever auth changes.
  useEffect(() => {
    if (auth?.loggedIn)
      agentInfo()
        .then(setAgent)
        .catch(() => setAgent(null));
  }, [auth?.loggedIn]);

  return (
    <div className="mx-auto max-w-[47.5rem] space-y-9 pb-10">
      <AccountSection auth={auth} agent={auth?.loggedIn ? agent : null} onAuthChange={onAuthChange} />

      <Section title="Labs" description="How labs start on this machine. Saved on this computer only." saved={labsSaved}>
        <AttackBoxRows onSaved={flashLabs} />
        <HypervisorRow report={report} onSaved={flashLabs} onNavigate={onNavigate} />
      </Section>

      <AboutSection version={version} report={report} agent={auth?.loggedIn ? agent : null} />
    </div>
  );
}
