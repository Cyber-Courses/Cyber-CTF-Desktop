"use client";

import { ArrowLeft, Cloud, KeyRound, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Choice, ChoiceGrid } from "@/components/ui/choice-card";
import { StatusDot } from "@/components/ui/status-pill";
import { MarkTile, Nav, Note, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function AccountStep({ s }: { s: HostSetup }) {
  const { onDone, v, i, set, next, back } = s;
  return (
    <Step icon={Cloud} title="How to connect" description="Choose how the launcher signs in to AWS.">
      <Note className="mb-4 flex items-start gap-2.5">
        <StatusDot tone="warn" className="mt-1.5" />
        <span className="text-muted-foreground">
          Labs run in your account and are billed while they run; the cost depends on each lab&apos;s size. Stopping a lab, or its auto-stop, destroys what it
          created.
        </span>
      </Note>
      <ChoiceGrid>
        <Choice
          selected={!!v.useCliCreds}
          onSelect={() => set("useCliCreds", true)}
          mark={
            <MarkTile>
              <Terminal className="size-4" />
            </MarkTile>
          }
          title="Use the AWS CLI"
          note="A profile or browser sign-in. No secret stored."
        />
        <Choice
          selected={!v.useCliCreds}
          onSelect={() => set("useCliCreds", false)}
          mark={
            <MarkTile>
              <KeyRound className="size-4" />
            </MarkTile>
          }
          title="Access keys"
          note="An IAM user's key and secret."
        />
      </ChoiceGrid>
      <Nav
        left={
          i > 0 ? (
            <Button variant="ghost" onClick={back}>
              <ArrowLeft className="size-4" /> Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )
        }
        right={<Button onClick={next}>Continue</Button>}
      />
    </Step>
  );
}
