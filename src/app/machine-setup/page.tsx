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
  useEffect(check, []);
  const close = () => getCurrentWindow().close().catch(() => {});

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Overlay title bar: room for the traffic lights, drag the window from the strip. */}
      <div data-tauri-drag-region className="h-10 select-none" />
      <main className="mx-auto max-w-2xl px-6 pb-8">
        <MachineSetup report={report} onRefresh={check} onClose={close} />
      </main>
    </div>
  );
}
