"use client";

import { ArrowLeft, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function AccountStep({ s }: { s: HostSetup }) {
  const { onDone, v, i, set, next, back } = s;
  return (
    <Step icon={Cloud} title="How to connect" description="Choose how the launcher signs in to AWS.">
      <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[0.75rem] text-amber-500">
        Labs run in your account and are billed while they run; the cost depends on each lab&apos;s size. Stopping a lab, or its auto-stop, destroys what it
        created.
      </p>
      <div role="radiogroup" aria-label="How to connect" className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          role="radio"
          aria-checked={v.useCliCreds}
          aria-label="Use the AWS CLI"
          onClick={() => set("useCliCreds", true)}
          className={cn(
            "rounded-lg border p-3 text-left transition-colors",
            v.useCliCreds ? "border-learn bg-learn/5 ring-1 ring-learn/40" : "border-border hover:border-ring/60",
          )}
        >
          <span className="block text-[0.78125rem] font-medium">Use the AWS CLI</span>
          <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">A profile or browser sign-in. No secret stored.</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!v.useCliCreds}
          aria-label="Access keys"
          onClick={() => set("useCliCreds", false)}
          className={cn(
            "rounded-lg border p-3 text-left transition-colors",
            !v.useCliCreds ? "border-learn bg-learn/5 ring-1 ring-learn/40" : "border-border hover:border-ring/60",
          )}
        >
          <span className="block text-[0.78125rem] font-medium">Access keys</span>
          <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">An IAM user&apos;s key and secret.</span>
        </button>
      </div>
      <Nav
        left={
          i > 0 ? (
            <Button variant="outline" onClick={back}>
              <ArrowLeft className="size-4" /> Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )
        }
        right={
          <Button variant="learn" onClick={next}>
            Continue
          </Button>
        }
      />
    </Step>
  );
}
