"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HostSetupPage, SetupTrademarks, EMPTY_CLOUD, EMPTY_HOST } from "@/components/server/host-setup";
import { Spinner } from "@/components/ui/spinner";
import { SERVER_CHANGED, serverList, systemCheck, type ServerHostInput, type SystemReport } from "@/lib/tauri";

/** The server setup window (opened by `server_open_setup`), closed when setup ends. */
function Setup() {
  const params = useSearchParams();
  const id = params.get("id");
  const empty = params.get("kind") === "cloud" ? EMPTY_CLOUD : EMPTY_HOST;
  const [initial, setInitial] = useState<ServerHostInput | null>(id ? null : { ...empty });
  const [report, setReport] = useState<SystemReport | null>(null);

  const check = () => {
    systemCheck().then(setReport).catch(() => {});
  };
  useEffect(check, []);
  useEffect(() => {
    if (!id) return;
    serverList()
      .then((l) => {
        const h = l.hosts.find((x) => x.id === id);
        setInitial(h ? { ...h, password: null } : { ...empty });
      })
      .catch(() => setInitial({ ...empty }));
  }, [id, empty]);

  const close = () => getCurrentWindow().close().catch(() => {});

  const cloud = (id ? initial?.provider === "aws" : params.get("kind") === "cloud");

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Overlay title bar: drags the window and clears the macOS traffic lights. */}
      <div data-tauri-drag-region className="h-11 shrink-0 select-none" />

      {!initial ? (
        <div className="flex flex-1 items-center justify-center gap-2 pb-11 text-[0.8125rem] text-muted-foreground">
          <Spinner className="size-4" /> Loading…
        </div>
      ) : (
        /* Scrolls when a step is long; centered in the window when it's short. */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-6 pt-2 pb-10">
            <HostSetupPage
              initial={initial}
              report={report}
              onRefresh={check}
              onSaved={() => emit(SERVER_CHANGED).catch(() => {})}
              onDone={close}
            />
            <div className="mt-8">
              <SetupTrademarks cloud={cloud} />
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

export default function ServerSetupWindow() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}
