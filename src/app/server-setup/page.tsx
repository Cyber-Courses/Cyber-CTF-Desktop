"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Image from "next/image";
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
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Overlay title bar: the strip drags the window and clears the macOS traffic lights. */}
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-end px-4 select-none">
        <span className="pointer-events-none flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          <Image src="/logo-mark.svg" alt="" width={14} height={14} className="size-3.5" priority /> CyberCTF · {cloud ? "Cloud" : "Server"} setup
        </span>
      </div>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6">
        {initial ? (
          <HostSetupPage
            initial={initial}
            report={report}
            onRefresh={check}
            onSaved={() => emit(SERVER_CHANGED).catch(() => {})}
            onDone={close}
          />
        ) : (
          <p className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground"><Spinner className="size-4" /> Loading…</p>
        )}
        <div className="mt-auto border-t border-border/60 py-4">
          <SetupTrademarks />
        </div>
      </main>
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
