"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { forceQuit, lingerQuit } from "@/lib/tauri";
import { useFocusTrap } from "@/lib/use-focus-trap";

/**
 * When the user tries to quit while a lab is still deploying, the Rust side holds the window
 * open and emits `quit-blocked`; this shows a confirmation so an in-flight deploy (a cloud
 * apply especially, which keeps billing if cut off) isn't interrupted by accident.
 */
export function QuitGuard() {
  const [count, setCount] = useState<number | null>(null);
  const [quitting, setQuitting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = listen<number>("quit-blocked", (e) => setCount(typeof e.payload === "number" ? e.payload : 1));
    return () => void off.then((f) => f());
  }, []);
  useFocusTrap(ref, count !== null);

  if (count === null) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
      <div ref={ref} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="quit-guard-title" className="w-full max-w-[26rem] rounded-xl border border-border bg-card p-5 shadow-2xl shadow-black/50 outline-none">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-500">
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0">
            <p id="quit-guard-title" className="text-sm font-semibold text-foreground">A lab is still deploying</p>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
              {count > 1 ? `${count} labs are` : "A lab is"} setting up inside the app. Quitting now can leave machines half-created, and a
              lab on a cloud account keeps billing until it is torn down. Let it finish in the background (the app closes
              by itself when it is done), keep waiting, or stop the lab first.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCount(null)}>
            Keep waiting
          </Button>
          <Button
            variant="learn"
            size="sm"
            disabled={quitting}
            onClick={() => {
              setQuitting(true);
              void lingerQuit().catch(() => setQuitting(false));
            }}
          >
            Finish in background
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={quitting}
            onClick={() => {
              setQuitting(true);
              void forceQuit().catch(() => setQuitting(false));
            }}
          >
            Quit anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
