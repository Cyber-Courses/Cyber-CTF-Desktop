"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloudProvider } from "@/lib/tauri";
import { Step } from "@/features/cloud/tool-rows";

/** Providers shown as "coming soon" in the Environment panel (logo = SVG in public/brands). */
export const COMING_SOON: { id: string; label: string; logo: boolean }[] = [];

const PROVIDERS: { id: CloudProvider; label: string }[] = [
  { id: "aws", label: "Amazon Web Services" },
  { id: "azure", label: "Microsoft Azure" },
  { id: "gcp", label: "Google Cloud" },
];

export function FirstRun({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="flex items-center justify-center gap-3">
        {PROVIDERS.map((p) => (
          // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
          <img key={p.id} src={`/brands/${p.id}.svg`} alt={p.label} className="size-7" draggable={false} />
        ))}
      </div>
      <p className="mt-3 text-[0.8125rem] font-medium">Run labs in your own cloud account</p>
      <p className="mx-auto mt-1 max-w-sm text-[0.75rem] text-muted-foreground">
        One throwaway instance per lab, destroyed when you stop it. Runs on AWS, Azure or Google Cloud.
      </p>
      <div className="mx-auto mt-5 grid max-w-md gap-2 text-left">
        <Step n={1} title="Connect an account" body="Access keys or your AWS CLI credentials, and a region." />
        <Step n={2} title="Pick it on a lab" body="Terraform creates one instance, reachable over SSH from your IP." />
        <Step n={3} title="Attack, then Stop" body="Stop destroys the instance, so billing stops with it." />
      </div>
      <Button variant="learn" size="sm" className="mt-5" onClick={onSetup}>
        <Plus className="size-3.5" /> Set up cloud provider
      </Button>
    </div>
  );
}
