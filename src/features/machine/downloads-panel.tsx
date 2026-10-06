"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
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
        action={
          storage && storeItems.length > 0 && !confirmClean ? (
            <Button variant="outline" size="sm" onClick={() => setConfirmClean(true)} disabled={cleaning}>
              <Trash2 className="size-3.5" /> Clean up
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
            className="flex w-full items-center gap-3 border-b border-border px-3.5 py-2.5 text-left last:border-b-0 enabled:hover:bg-muted/40"
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", showStorage && "rotate-90", storeItems.length === 0 && "opacity-0")}
            />
            <div className="min-w-0 flex-1 text-[0.78125rem]">
              <p className="font-medium">{storeItems.length ? `${formatBytes(storeTotal)} of lab downloads` : "No lab downloads yet"}</p>
              <p className="text-[0.71875rem] text-muted-foreground">
                {storage.images.length} container image{storage.images.length === 1 ? "" : "s"} · {storage.boxes.length} VM image
                {storage.boxes.length === 1 ? "" : "s"}
              </p>
            </div>
          </button>
          {showStorage &&
            storeItems.map((it) => (
              <div key={it.name} className="flex items-center gap-3 border-b border-border py-1.5 pr-3.5 pl-10 text-[0.75rem] last:border-b-0">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.71875rem] text-muted-foreground">{it.name}</span>
                <span className="tabular-nums text-muted-foreground">{formatBytes(it.bytes)}</span>
              </div>
            ))}
          {confirmClean && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/30 px-3.5 py-3">
              <p className="min-w-0 flex-1 text-[0.75rem]">
                Remove {formatBytes(storeTotal)}? Labs download what they need again on their next start. Anything in use stays.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmClean(false)} disabled={cleaning}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={clean} disabled={cleaning}>
                  {cleaning ? (
                    <>
                      <Spinner className="size-3.5" /> Removing…
                    </>
                  ) : (
                    "Remove"
                  )}
                </Button>
              </div>
            </div>
          )}
          {freed !== null && !confirmClean && (
            <p className="border-t border-border px-3.5 py-2 text-[0.75rem] text-muted-foreground">
              {freed > 0 ? `Freed ${formatBytes(freed)}.` : "Nothing could be removed (all in use)."}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
