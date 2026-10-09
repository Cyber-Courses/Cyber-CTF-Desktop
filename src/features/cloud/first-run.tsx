"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloudProvider } from "@/lib/tauri";
import { Step } from "@/features/cloud/tool-rows";
import { LogoTile } from "@/features/cloud/account-row";
import { useT } from "@/lib/i18n";

/** Providers shown as "coming soon" in the Environment panel (logo = SVG in public/brands). */
export const COMING_SOON: { id: string; label: string; logo: boolean }[] = [];

const PROVIDERS: { id: CloudProvider; label: string }[] = [
  { id: "aws", label: "Amazon Web Services" },
  { id: "azure", label: "Microsoft Azure" },
  { id: "gcp", label: "Google Cloud" },
];

export function FirstRun({ onSetup }: { onSetup: () => void }) {
  const t = useT();
  return (
    <div className="surface-panel flex flex-col items-center rounded-panel px-6 py-10 text-center">
      <div className="flex items-center justify-center gap-2.5">
        {PROVIDERS.map((p) => (
          <LogoTile key={p.id} provider={p.id} label={p.label} />
        ))}
      </div>
      <h3 className="serif-title mt-4 text-[1.5rem] text-foreground">{t("cloud.firstRun.title")}</h3>
      <p className="mt-1.5 max-w-sm text-[0.875rem] text-muted-foreground">{t("cloud.firstRun.body")}</p>
      <div className="mt-5 w-full max-w-md overflow-hidden rounded-control bg-glass shadow-[inset_0_0_0_1px_var(--border)]">
        <Step n={1} title={t("cloud.firstRun.steps.connect.title")} body={t("cloud.firstRun.steps.connect.body")} />
        <Step n={2} title={t("cloud.firstRun.steps.pick.title")} body={t("cloud.firstRun.steps.pick.body")} />
        <Step n={3} title={t("cloud.firstRun.steps.stop.title")} body={t("cloud.firstRun.steps.stop.body")} />
      </div>
      <Button size="sm" className="mt-5" onClick={onSetup}>
        <Plus className="size-3.5" /> {t("cloud.screen.setUp")}
      </Button>
    </div>
  );
}
