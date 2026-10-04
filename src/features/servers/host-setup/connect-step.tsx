"use client";

import { ArrowLeft, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { CLOUD_META } from "@/features/servers/host-setup/constants";
import { Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function ConnectStep({ s }: { s: HostSetup }) {
  const { report, onDone, cloudProvider, signingIn, signInLog, back, signIn } = s;
  return (
    <Step
      icon={Cloud}
      title={`Connect ${CLOUD_META[cloudProvider].label}`}
      description="Sign in with the provider's CLI. Nothing is stored by Cyber CTF; Terraform uses the CLI's credentials."
    >
      <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[0.75rem] text-amber-500">
        Lab provisioning for {CLOUD_META[cloudProvider].label} is coming. Sign in now so the CLI is ready; AWS is the supported target today.
      </p>
      {report?.cloudClis[cloudProvider === "gcp" ? "gcloud" : cloudProvider]?.installed ? (
        <>
          <Button variant="learn" onClick={signIn} disabled={signingIn}>
            {signingIn && <Spinner className="size-4" />} Sign in with {CLOUD_META[cloudProvider].cli}
          </Button>
          {signInLog && (
            <div className="mt-3">
              <LogConsole lines={signInLog} running={signingIn} title="Sign in" />
            </div>
          )}
        </>
      ) : (
        <p className="text-[0.78125rem] text-muted-foreground">
          The {CLOUD_META[cloudProvider].cli} CLI isn&apos;t installed. Install it from the Cloud page first, then come back.
        </p>
      )}
      <Nav
        left={
          <Button variant="outline" onClick={back}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        }
        right={
          <Button variant="learn" onClick={onDone}>
            Done
          </Button>
        }
      />
    </Step>
  );
}
