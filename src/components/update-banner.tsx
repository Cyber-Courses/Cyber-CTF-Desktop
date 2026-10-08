"use client";

import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";
import { restartApp } from "@/lib/tauri";
import { cn } from "@/lib/utils";
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
        /* offline, dev, or no update endpoint: stay silent */
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
    <div role="status" className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-jewel/[0.06] px-6 text-[0.8125rem]">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", phase === "error" ? "bg-destructive" : "bg-jewel")} />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {phase === "ready" ? (
          "Update installed. Restarting Cyber CTF…"
        ) : phase === "error" ? (
          "Update failed. Try again later."
        ) : (
          <>
            Version <span className="font-mono text-[0.75rem]">{update.version}</span> is available.
          </>
        )}
      </span>
      {phase === "ready" ? (
        <Button size="xs" onClick={() => restartApp().catch(tell("Couldn't restart Cyber CTF"))}>
          Restart now
        </Button>
      ) : (
        <Button size="xs" onClick={install} disabled={phase === "downloading"}>
          {phase === "downloading" ? "Updating…" : "Update"}
        </Button>
      )}
    </div>
  );
}
