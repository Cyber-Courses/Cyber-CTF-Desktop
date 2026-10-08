"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmLaunch } from "@/lib/tauri";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { tell } from "@/lib/failure";

type Request = { sessionId: string; repository: string; commit: string; target: string };

/**
 * A website-launched lab that would run on one of the player's cloud accounts (which costs
 * money) isn't started unattended: the agent emits `launch-confirm` and waits here for the
 * player to approve or decline on this machine.
 */
export function LaunchConfirm() {
  const [req, setReq] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = listen<Request>("launch-confirm", (e) => setReq(e.payload));
    return () => void off.then((f) => f());
  }, []);
  useFocusTrap(ref, !!req);

  if (!req) return null;

  const answer = (approve: boolean) => {
    setBusy(true);
    void confirmLaunch(req.sessionId, approve)
      .catch(tell("Couldn't send your answer to Cyber CTF"))
      .finally(() => {
        setBusy(false);
        setReq(null);
      });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
      <div
        ref={ref}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm a cloud lab launch"
        className="w-full max-w-[28rem] rounded-xl border border-border bg-card p-5 shadow-2xl shadow-black/50 outline-none"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-learn/30 bg-learn/10 text-learn">
            <Cloud className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Run this lab on your cloud account?</p>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
              A launch from the website wants to run on <span className="text-foreground">{req.target}</span>. This starts billable resources on your account
              (they auto-stop later). Only approve a launch you started.
            </p>
            <div className="mt-2.5 space-y-0.5 font-mono text-[0.6875rem] text-muted-foreground">
              <p className="truncate">repo: {req.repository}</p>
              <p className="truncate">commit: {req.commit.slice(0, 12)}</p>
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => answer(false)}>
            Decline
          </Button>
          <Button variant="learn" size="sm" disabled={busy} onClick={() => answer(true)}>
            Run on my cloud
          </Button>
        </div>
      </div>
    </div>
  );
}
