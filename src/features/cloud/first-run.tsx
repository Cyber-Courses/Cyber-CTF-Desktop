"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloudProvider } from "@/lib/tauri";
import { Step } from "@/features/cloud/tool-rows";
import { LogoTile } from "@/features/cloud/account-row";

/** Providers shown as "coming soon" in the Environment panel (logo = SVG in public/brands). */
export const COMING_SOON: { id: string; label: string; logo: boolean }[] = [];

const PROVIDERS: { id: CloudProvider; label: string }[] = [
  { id: "aws", label: "Amazon Web Services" },
  { id: "azure", label: "Microsoft Azure" },
  { id: "gcp", label: "Google Cloud" },
];

export function FirstRun({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="surface-panel flex flex-col items-center rounded-panel px-6 py-10 text-center">
      <div className="flex items-center justify-center gap-2.5">
        {PROVIDERS.map((p) => (
          <LogoTile key={p.id} provider={p.id} label={p.label} />
        ))}
      </div>
      <h3 className="serif-title mt-4 text-[1.5rem] text-foreground">Run labs in your own cloud account</h3>
      <p className="mt-1.5 max-w-sm text-[0.875rem] text-muted-foreground">
        One throwaway instance per lab, destroyed when you stop it. Runs on AWS, Azure or Google Cloud.
      </p>
      <div className="mt-5 w-full max-w-md overflow-hidden rounded-control bg-glass shadow-[inset_0_0_0_1px_var(--border)]">
        <Step n={1} title="Connect an account" body="Access keys or your AWS CLI credentials, and a region." />
        <Step n={2} title="Pick it on a lab" body="Terraform creates one instance, reachable over SSH from your IP." />
        <Step n={3} title="Attack, then Stop" body="Stop destroys the instance, so billing stops with it." />
      </div>
      <Button size="sm" className="mt-5" onClick={onSetup}>
        <Plus className="size-3.5" /> Set up cloud provider
      </Button>
    </div>
  );
}
