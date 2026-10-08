"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Play, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { labCheck, type LabCheck } from "@/lib/tauri";

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
      .catch((e) => alive && setCheck({ available: true, ok: false, output: String(e), results: [] }));
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
  onResume,
}: {
  down: string[];
  check: CheckState;
  busy: boolean;
  resetting: boolean;
  onReset: () => void;
  /** VM labs: bring the down machines back as they are (no rebuild), before reaching for Reset. */
  onResume?: () => void;
}) {
  return (
    <div role="status" className="surface-panel flex flex-wrap items-center gap-3 rounded-panel px-4 py-3">
      <AlertTriangle className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-[0.8125rem]">
        <p className="text-foreground">
          {down.join(", ")} {down.length > 1 ? "are" : "is"} down. The lab may not work.
        </p>
        {check === "checking" && (
          <p className="mt-0.5 flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
            <Spinner className="size-3" /> Checking whether it&apos;s still solvable…
          </p>
        )}
        {check && check !== "checking" && check.available && (
          <>
            <p className="mt-0.5 flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
              {check.ok ? <ShieldCheck className="size-3.5 text-success" /> : <ShieldAlert className="size-3.5 text-destructive" />}
              {check.ok ? "Still solvable." : "It can no longer be solved. Reset it to get a clean lab."}
            </p>
            {!check.ok && check.results.some((r) => !r.ok) && (
              <ul className="mt-1 space-y-0.5 font-mono text-[0.6875rem] text-faint">
                {check.results
                  .filter((r) => !r.ok)
                  .slice(0, 5)
                  .map((r) => (
                    <li key={`${r.from}/${r.name}`} className="truncate">
                      {r.name}
                      {r.reason ? `: ${r.reason}` : ""}
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
      </div>
      {onResume && (
        <Button variant="outline" size="sm" onClick={onResume} disabled={busy || resetting} title="Start the machines that are down, keeping their state">
          <Play className="size-3.5" /> Start them
        </Button>
      )}
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
