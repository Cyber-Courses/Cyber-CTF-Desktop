"use client";

import { useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Check, Copy, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { restartApp, type AgentInfo, type SystemReport } from "@/lib/tauri";
import { getAttackBox, getAttackImage, getVmProvider } from "@/lib/settings";
import { Row, Section } from "@/features/settings/settings-layout";
import { ONBOARDED_KEY } from "@/features/settings/settings-screen";
import { tell } from "@/lib/failure";
import { emit } from "@tauri-apps/api/event";
import { closeIfSettings, REPLAY_ONBOARDING_EVENT } from "@/lib/app-events";

/* ------------------------------------------------------------------ about */

type UpdateState = { phase: "idle" | "checking" | "none" | "error" } | { phase: "available" | "installing" | "installed"; update: Update };

export function AboutSection({ version, report, agent }: { version: string | null; report: SystemReport | null; agent: AgentInfo | null }) {
  const [upd, setUpd] = useState<UpdateState>({ phase: "idle" });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  async function checkUpdates() {
    setUpd({ phase: "checking" });
    try {
      const u = await check();
      setUpd(u ? { phase: "available", update: u } : { phase: "none" });
    } catch {
      setUpd({ phase: "error" });
    }
    setCheckedAt(Date.now());
  }

  async function install() {
    if (!("update" in upd)) return;
    const { update } = upd;
    setUpd({ phase: "installing", update });
    try {
      await update.downloadAndInstall();
      setUpd({ phase: "installed", update });
    } catch {
      setUpd({ phase: "available", update });
      return;
    }
    // Reopen on the new version straight away; Restart now stays as the fallback.
    await restartApp().catch(tell("Couldn't restart Cyber CTF"));
  }

  async function copyDiagnostics() {
    const lines = [
      `Cyber CTF ${version ? `v${version}` : "(unknown version)"}`,
      report ? `OS: ${report.os} ${report.arch}` : null,
      report
        ? `Docker: ${report.dockerRunning ? `running (${report.dockerEngine ?? "unknown engine"})` : report.docker.installed ? "installed, not running" : "not installed"}`
        : null,
      report
        ? `Vagrant: ${report.vagrant.installed ? "installed" : "not installed"}, Terraform: ${report.terraform.installed ? "installed" : "not installed"}`
        : null,
      report
        ? `Hypervisors ready: ${
            report.vmProviders
              .filter((p) => !p.remote && p.available)
              .map((p) => p.provider)
              .join(", ") || "none"
          }`
        : null,
      `Attack box: ${getAttackImage()}`,
      `Attack VM: ${getAttackBox()}`,
      `VM provider: ${getVmProvider() ?? "automatic"}`,
      agent ? `Install ID: ${agent.installId}` : "Not signed in",
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  // The onboarding shows in the main window: it is asked to show it again (a reload here only
  // reloaded the Settings window, which never shows it).
  function replayOnboarding() {
    try {
      localStorage.removeItem(ONBOARDED_KEY);
    } catch {
      /* ignore */
    }
    emit(REPLAY_ONBOARDING_EVENT).catch(tell("Couldn't replay the setup"));
    closeIfSettings();
  }

  const updateText = (() => {
    switch (upd.phase) {
      case "checking":
        return "Checking for updates…";
      case "none":
        return `You’re on the latest version${checkedAt ? `, checked at ${new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.`;
      case "error":
        return "Couldn’t reach the update server. Check your connection and try again.";
      case "available":
        return `Version ${upd.update.version} is available.`;
      case "installing":
        return `Downloading and installing ${upd.update.version}…`;
      case "installed":
        return `Version ${upd.update.version} is installed. Restarting Cyber CTF…`;
      default:
        return "Updates install automatically when you accept them from the banner.";
    }
  })();

  return (
    <Section title="About" description="Version, updates and what to send us when something breaks.">
      <KeyValue k="Version">{version ? `v${version}` : "…"}</KeyValue>
      {report && (
        <KeyValue k="System">
          {report.os} {report.arch}
        </KeyValue>
      )}
      {agent && <KeyValue k="Install ID">{agent.installId}</KeyValue>}
      <Row
        title={
          <span className="flex items-center gap-2">
            Updates
            {upd.phase === "available" && <Badge variant="accent">Update available</Badge>}
          </span>
        }
        description={updateText}
        control={
          upd.phase === "available" || upd.phase === "installing" ? (
            <Button size="xs" onClick={install} disabled={upd.phase === "installing"}>
              {upd.phase === "installing" ? (
                <>
                  <Spinner className="size-3.5" /> Installing…
                </>
              ) : (
                "Install update"
              )}
            </Button>
          ) : upd.phase === "installed" ? (
            <Button size="xs" onClick={() => restartApp().catch(tell("Couldn't restart Cyber CTF"))}>
              Restart now
            </Button>
          ) : (
            <Button variant="outline" size="xs" onClick={checkUpdates} disabled={upd.phase === "checking"}>
              {upd.phase === "checking" ? (
                <>
                  <Spinner className="size-3.5" /> Checking…
                </>
              ) : (
                "Check for updates"
              )}
            </Button>
          )
        }
      />
      <Row
        title="Diagnostics"
        description="Copies your version, OS and setup status, for a bug report or a support request."
        control={
          <Button variant="outline" size="xs" onClick={copyDiagnostics}>
            {copied ? (
              <>
                <Check className="size-3.5 text-success" /> Copied
              </>
            ) : (
              <>
                <Copy className="size-3.5" /> Copy
              </>
            )}
          </Button>
        }
      />
      <Row
        title="First-run setup"
        description="Walk through the onboarding again. Your settings and labs are kept."
        control={
          <Button variant="ghost" size="xs" onClick={replayOnboarding}>
            <RotateCcw className="size-3.5" /> Replay
          </Button>
        }
      />
    </Section>
  );
}
