"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HostSetupPage, EMPTY_CLOUD, EMPTY_HOST } from "@/components/homelab/host-setup";
import { Spinner } from "@/components/ui/spinner";
import { HOMELAB_CHANGED, homelabList, systemCheck, type HomelabHostInput, type SystemReport } from "@/lib/tauri";

/** The home-lab setup window (opened by `homelab_open_setup`), closed when setup ends. */
function Setup() {
  const params = useSearchParams();
  const id = params.get("id");
  const empty = params.get("kind") === "cloud" ? EMPTY_CLOUD : EMPTY_HOST;
  const [initial, setInitial] = useState<HomelabHostInput | null>(id ? null : { ...empty });
  const [report, setReport] = useState<SystemReport | null>(null);

  const check = () => {
    systemCheck().then(setReport).catch(() => {});
  };
  useEffect(check, []);
  useEffect(() => {
    if (!id) return;
    homelabList()
      .then((l) => {
        const h = l.hosts.find((x) => x.id === id);
        setInitial(h ? { ...h, password: null } : { ...empty });
      })
      .catch(() => setInitial({ ...empty }));
  }, [id, empty]);

  const close = () => getCurrentWindow().close().catch(() => {});

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Overlay title bar: leave room for the traffic lights and let the strip drag the window. */}
      <div data-tauri-drag-region className="h-10 select-none" />
      <main className="mx-auto max-w-2xl px-6 pb-8">
        {initial ? (
          <HostSetupPage
            initial={initial}
            report={report}
            onRefresh={check}
            onSaved={() => emit(HOMELAB_CHANGED).catch(() => {})}
            onDone={close}
          />
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner className="size-4" /> Loading…</p>
        )}
      </main>
    </div>
  );
}

export default function HomelabSetupWindow() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}
