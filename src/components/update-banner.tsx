"use client";

import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";
import { restartApp } from "@/lib/tauri";
import { tell } from "@/lib/failure";

/**
 * Checks for an update on launch (via plugins.updater) and offers a one-click install.
 * Silent when up to date or when the check fails (offline, dev). After install the app relaunches
 * itself through a tiny command (no process plugin needed); Restart now is the fallback.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<"idle" | "downloading" | "ready" | "error">("idle");

  useEffect(() => {
    check()
      .then((u) => {
        if (u) setUpdate(u);
      })
      .catch(() => {
        /* offline, dev, or no update endpoint - stay silent */
      });
  }, []);

  if (!update) return null;

  async function install() {
    if (!update) return;
    setPhase("downloading");
    try {
      await update.downloadAndInstall();
      setPhase("ready");
      // Reopen on the new version straight away; the button stays as a fallback if it can't.
      await restartApp();
    } catch {
      setPhase("error");
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-jewel/10 px-6 py-2.5 text-sm">
      <span className="text-foreground">
        {phase === "ready"
          ? "Update installed. Restarting Cyber CTF…"
          : phase === "error"
            ? "Update failed. Try again later."
            : `Version ${update.version} is available.`}
      </span>
      {phase === "ready" ? (
        <Button variant="primary" size="sm" onClick={() => restartApp().catch(tell("Couldn't restart Cyber CTF"))}>
          Restart now
        </Button>
      ) : (
        <Button variant="primary" size="sm" onClick={install} disabled={phase === "downloading"}>
          {phase === "downloading" ? "Updating…" : "Update"}
        </Button>
      )}
    </div>
  );
}
