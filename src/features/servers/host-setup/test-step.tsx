"use client";

import { CheckCircle2, Play, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Nav, Note, Step } from "@/features/servers/host-setup/form";
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
        <Note className="flex items-start gap-3 p-3.5">
          {test.ok ? <CheckCircle2 className="mt-px size-4 shrink-0 text-success" /> : <XCircle className="mt-px size-4 shrink-0 text-destructive" />}
          <p className="min-w-0 text-[0.8125rem] break-words text-foreground">
            {test.message}
            {test.latencyMs != null && <span className="ml-1.5 font-mono text-[0.6875rem] text-faint">{test.latencyMs} ms</span>}
          </p>
        </Note>
      )}
      <Nav
        left={
          <Button variant="outline" onClick={() => saved && runTest(saved.id)} disabled={test === "testing"}>
            Test again
          </Button>
        }
        right={
          <Button onClick={onDone}>
            <Play className="size-4" /> Done
          </Button>
        }
      />
    </Step>
  );
}
