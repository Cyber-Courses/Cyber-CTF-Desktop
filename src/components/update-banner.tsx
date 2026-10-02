"use client";

import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";

/**
 * Checks for an update on launch (via plugins.updater) and offers a one-click install.
 * Silent when up to date or when the check fails (offline, dev). After install the user
 * restarts to apply - we avoid depending on the process plugin for relaunch.
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
    } catch {
      setPhase("error");
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-learn/10 px-6 py-2.5 text-sm">
      <span className="text-foreground">
        {phase === "ready"
          ? "Update installed. Restart Cyber CTF to apply it."
          : phase === "error"
            ? "Update failed. Try again later."
            : `Version ${update.version} is available.`}
      </span>
      {phase !== "ready" && (
        <Button variant="learn" size="sm" onClick={install} disabled={phase === "downloading"}>
          {phase === "downloading" ? "Updating…" : "Update"}
        </Button>
      )}
    </div>
  );
}
