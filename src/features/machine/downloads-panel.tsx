"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-pill";
import { ListSkeleton } from "@/features/machine/machine-parts";
import { formatBytes } from "@/lib/format";
import { getAttackImage } from "@/lib/settings";
import { machineStorage, machineStorageClean, type Storage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Downloaded container images and VM boxes, with a confirmed clean-up (the attack box image
 *  and anything in use are kept). */
export function DownloadsPanel() {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [showStorage, setShowStorage] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const load = useCallback(() => {
    machineStorage([getAttackImage()])
      .then((s) => alive.current && setStorage(s))
      .catch(() => alive.current && setStorage({ images: [], boxes: [] }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function clean() {
    setCleaning(true);
    try {
      setFreed(await machineStorageClean([getAttackImage()]));
    } catch {
      setFreed(0);
    } finally {
      setCleaning(false);
      setConfirmClean(false);
      load();
    }
  }

  const storeItems = storage ? [...storage.images, ...storage.boxes] : [];
  const storeTotal = storeItems.reduce((a, i) => a + i.bytes, 0);
  return (
    <Panel>
      <PanelHeader
        title="Downloads"
        meta={storage && storeItems.length > 0 ? <span className="tabular-nums">{formatBytes(storeTotal)}</span> : undefined}
        action={
          storage && storeItems.length > 0 && !confirmClean ? (
            <Button variant="outline" size="xs" onClick={() => setConfirmClean(true)} disabled={cleaning}>
              <Trash2 /> Clean up
            </Button>
          ) : undefined
        }
      />
      {storage === null ? (
        <ListSkeleton />
      ) : (
        <>
          <button
            onClick={() => setShowStorage((v) => !v)}
            disabled={storeItems.length === 0}
            aria-expanded={showStorage}
            className="flex min-h-[3.25rem] w-full items-center gap-3 px-4 py-2 text-left transition-colors enabled:hover:bg-glass"
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", showStorage && "rotate-90", storeItems.length === 0 && "opacity-0")}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[0.8125rem] font-medium text-foreground">
                {storeItems.length ? `${formatBytes(storeTotal)} of lab downloads` : "No lab downloads yet"}
              </p>
              <p className="font-mono text-[0.6875rem] text-faint">
                {storage.images.length} container image{storage.images.length === 1 ? "" : "s"} · {storage.boxes.length} VM image
                {storage.boxes.length === 1 ? "" : "s"}
              </p>
            </div>
          </button>
          {showStorage &&
            storeItems.map((it) => (
              <div key={it.name} className="flex items-center gap-3 border-t border-border py-2 pr-4 pl-10 transition-colors hover:bg-glass">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted-foreground">{it.name}</span>
                <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-faint">{formatBytes(it.bytes)}</span>
              </div>
            ))}
          {confirmClean && (
            <div role="alert" className="flex flex-wrap items-center gap-3 border-t border-border bg-glass px-4 py-3">
              <StatusDot tone="warn" />
              <p className="min-w-0 flex-1 text-[0.75rem] text-foreground">
                Remove {formatBytes(storeTotal)}? Labs download what they need again on their next start. Anything in use stays.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="xs" onClick={() => setConfirmClean(false)} disabled={cleaning}>
                  Cancel
                </Button>
                <Button variant="destructive" size="xs" onClick={clean} disabled={cleaning}>
                  {cleaning ? (
                    <>
                      <Spinner className="size-3" /> Removing…
                    </>
                  ) : (
                    "Remove"
                  )}
                </Button>
              </div>
            </div>
          )}
          {freed !== null && !confirmClean && (
            <p className="border-t border-border px-4 py-2.5 text-[0.75rem] text-muted-foreground">
              {freed > 0 ? `Freed ${formatBytes(freed)}.` : "Nothing could be removed (all in use)."}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
