"use client";

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MachineSetup } from "@/components/machine/machine-setup";
import { systemCheck, type SystemReport } from "@/lib/tauri";

/** The guided machine-setup window (opened by `machine_open_setup`). */
export default function MachineSetupWindow() {
  const [report, setReport] = useState<SystemReport | null>(null);
  const check = () => {
    systemCheck().then(setReport).catch(() => {});
  };
  // Poll so an install (incl. one the user finishes in a native installer) is detected as
  // done and the steps update, without a manual re-check.
  useEffect(() => {
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, []);
  const close = () => getCurrentWindow().close().catch(() => {});

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Overlay title bar: room for the traffic lights, drag the window from the strip. */}
      <div data-tauri-drag-region className="h-10 shrink-0 select-none" />
      {/* Centered in the window; the bottom pad mirrors the title strip so it sits optically centered. */}
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 pb-10">
        <MachineSetup report={report} onRefresh={check} onClose={close} />
      </main>
    </div>
  );
}
