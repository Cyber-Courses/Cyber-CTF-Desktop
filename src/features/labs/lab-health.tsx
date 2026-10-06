"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { labCheck, type LabCheck } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export type CheckState = LabCheck | "checking" | null;

/** When a container goes down, check (once per incident) whether the lab is still solvable. */
export function useLabCheck(labId: string, { running, downCount, enabled }: { running: boolean; downCount: number; enabled: boolean }) {
  const [check, setCheck] = useState<CheckState>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!running || downCount === 0) {
      done.current = false;
      return;
    }
    if (!enabled || done.current) return;
    done.current = true;
    // The check's own state changes are the point; it runs in the background.
    setCheck("checking");
    let alive = true;
    labCheck(labId, "DOCKER")
      .then((c) => alive && setCheck(c))
      .catch((e) => alive && setCheck({ available: true, ok: false, output: String(e) }));
    return () => {
      alive = false;
    };
  }, [labId, running, downCount, enabled]);
  return [check, () => setCheck(null)] as const;
}

/** A container went down: say so, show the check, offer a clean restart. */
export function HealthBanner({
  down,
  check,
  busy,
  resetting,
  onReset,
}: {
  down: string[];
  check: CheckState;
  busy: boolean;
  resetting: boolean;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3.5">
      <AlertTriangle className="size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 text-[0.78125rem]">
        <p className="text-foreground">
          {down.join(", ")} {down.length > 1 ? "are" : "is"} down. The lab may not work.
        </p>
        {check === "checking" && (
          <p className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
            <Spinner className="size-3" /> Checking whether it&apos;s still solvable…
          </p>
        )}
        {check && check !== "checking" && check.available && (
          <p className={cn("mt-0.5 flex items-center gap-1.5", check.ok ? "text-emerald-500" : "text-rose-400")}>
            {check.ok ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
            {check.ok ? "Still solvable." : "It can no longer be solved. Reset it to get a clean lab."}
          </p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onReset} disabled={busy || resetting}>
        {resetting ? (
          <>
            <Spinner className="size-3.5" /> Resetting…
          </>
        ) : (
          <>
            <RotateCcw className="size-3.5" /> Reset lab
          </>
        )}
      </Button>
    </div>
  );
}
