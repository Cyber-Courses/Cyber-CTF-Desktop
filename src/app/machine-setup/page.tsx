"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MachineSetup } from "@/features/machine/machine-setup";
import { Toaster } from "@/components/ui/toaster";
import { systemCheck, type SystemReport } from "@/lib/tauri";
import { ignore, warn } from "@/lib/failure";

/** The guided machine-setup window (opened by `machine_open_setup`, optionally `?step=`). */
export default function MachineSetupWindow() {
  const [report, setReport] = useState<SystemReport | null>(null);
  // Deep link: the step in the URL on open, or a later "Fix" while the window is open.
  const [startAt, setStartAt] = useState<{ step: string; nonce: number } | null>(() => {
    const step = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("step");
    return step ? { step, nonce: 0 } : null;
  });
  const check = () => {
    systemCheck().then(setReport).catch(warn("system check"));
  };
  // Poll so an install (incl. one the user finishes in a native installer) is detected as
  // done and the steps update, without a manual re-check.
  useEffect(() => {
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const off = listen<string>("machine-setup-step", (e) => setStartAt({ step: e.payload, nonce: Date.now() }));
    return () => {
      off.then((f) => f()).catch(ignore("the listener never got set up"));
    };
  }, []);
  const close = () => getCurrentWindow().close().catch(warn("closing the window"));

  return (
    <>
      <MachineSetup report={report} onRefresh={check} onClose={close} startAt={startAt} />
      {/* This window has its own root (no app shell), so it mounts its own toasts. */}
      <Toaster />
    </>
  );
}
