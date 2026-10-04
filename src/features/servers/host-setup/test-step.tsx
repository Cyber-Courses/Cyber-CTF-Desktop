"use client";

import { CheckCircle2, Play, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function TestStep({ s }: { s: HostSetup }) {
  const { onDone, saved, test, runTest } = s;
  return (
    <Step icon={CheckCircle2} title="Connection test" description="Saved. Here's what the launcher could check from this machine.">
      {test === null || test === "testing" ? (
        <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
          <Spinner className="size-4" /> Testing the connection…
        </p>
      ) : (
        <div
          className={cn(
            "flex items-start gap-3 rounded-lg border p-3.5",
            test.ok ? "border-emerald-500/25 bg-emerald-500/10" : "border-rose-500/25 bg-rose-500/10",
          )}
        >
          {test.ok ? <CheckCircle2 className="mt-px size-5 shrink-0 text-emerald-500" /> : <XCircle className="mt-px size-5 shrink-0 text-rose-400" />}
          <p className={cn("text-[0.8125rem]", test.ok ? "text-foreground" : "text-rose-300")}>
            {test.message}
            {test.latencyMs != null && <span className="ml-1.5 font-mono text-[0.71875rem] text-muted-foreground">{test.latencyMs} ms</span>}
          </p>
        </div>
      )}
      <Nav
        left={
          <Button variant="outline" onClick={() => saved && runTest(saved.id)} disabled={test === "testing"}>
            Test again
          </Button>
        }
        right={
          <Button variant="learn" onClick={onDone}>
            <Play className="size-4" /> Done
          </Button>
        }
      />
    </Step>
  );
}
