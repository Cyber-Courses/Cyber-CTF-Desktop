"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Circle, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { serverSelftest, type SelfTestEvent, type ServerHost } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The step plan each provider reports, shown up front so the list doesn't grow as it runs. */
const SELFTEST_PLAN: Record<"proxmox" | "esxi", { step: string; label: string }[]> = {
  proxmox: [
    { step: "connect", label: "Reach the host" },
    { step: "prepare", label: "Prepare a test VM definition" },
    { step: "apply", label: "Create and boot the VM on the host" },
    { step: "boot", label: "VM reports a network address" },
    { step: "ssh", label: "SSH answers on the VM" },
    { step: "cleanup", label: "Destroy the test VM" },
  ],
  esxi: [
    { step: "connect", label: "Reach the host" },
    { step: "prepare", label: "Prepare a test VM definition" },
    { step: "up", label: "Create and boot the VM on the host" },
    { step: "ssh", label: "Run a command in the VM" },
    { step: "cleanup", label: "Destroy the test VM" },
  ],
};

/** Runs a real-VM self-test on a host and renders each step, like the machine VM test. It
 *  really provisions a throwaway VM on the server and destroys it, so it takes a few minutes. */
export function ServerSelfTest({ id, provider, onDone }: { id: string; provider: ServerHost["provider"]; onDone: (result: "ok" | "fail") => void }) {
  const plan = SELFTEST_PLAN[provider === "proxmox" ? "proxmox" : "esxi"];
  const [states, setStates] = useState<Record<string, { state: string; detail?: string }>>({});
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const hadFail = useRef(false);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    let alive = true;
    serverSelftest(id, (e: SelfTestEvent) => {
      if (e.state === "fail") hadFail.current = true;
      if (alive) setStates((s) => ({ ...s, [e.step]: { state: e.state, detail: e.detail ?? undefined } }));
    })
      .catch((err) => {
        hadFail.current = true;
        if (alive) setError(String(err));
      })
      .finally(() => {
        if (alive) {
          setRunning(false);
          doneRef.current(hadFail.current ? "fail" : "ok");
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const failed = Object.values(states).some((s) => s.state === "fail") || !!error;
  const elapsed = Math.max(0, Math.floor((now - startAt) / 1000));
  const fmt = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11.5px] font-medium">{running ? "Running a real VM on the host…" : failed ? "VM test failed" : "VM test passed"}</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">{fmt}</span>
      </div>
      <div className="divide-y divide-border/60">
        {plan.map((p) => {
          const st = states[p.step]?.state ?? "idle";
          return (
            <div key={p.step} className="flex items-start gap-2.5 px-3 py-2">
              <span className="mt-0.5">
                {st === "ok" ? (
                  <Check className="size-3.5 text-emerald-500" />
                ) : st === "fail" ? (
                  <X className="size-3.5 text-rose-500" />
                ) : st === "running" ? (
                  <Spinner className="size-3.5 text-learn" />
                ) : (
                  <Circle className={cn("size-3.5", st === "skip" ? "text-muted-foreground/40" : "text-muted-foreground/30")} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[12.5px]", st === "idle" ? "text-muted-foreground/60" : "text-foreground")}>{p.label}</p>
                {states[p.step]?.detail && <p className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">{states[p.step]!.detail}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="border-t border-border px-3 py-2 text-[11.5px] text-rose-500">{error}</p>}
    </div>
  );
}
