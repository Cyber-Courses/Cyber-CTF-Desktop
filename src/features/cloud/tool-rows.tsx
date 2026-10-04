"use client";

import { Button } from "@/components/ui/button";
import { type CloudProvider, type ProvisioningImage, type Tool } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { Status } from "@/features/cloud/account-row";

function Logo({ provider }: { provider: CloudProvider }) {
  // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
  return <img src={`/brands/${provider}.svg`} alt="" className="size-5 shrink-0" draggable={false} />;
}

export function CliRow({
  name,
  provider,
  tool,
  busy,
  locked,
  onInstall,
}: {
  name: string;
  provider: CloudProvider;
  tool?: Tool;
  busy: boolean;
  locked: boolean;
  onInstall: () => void;
}) {
  const installed = !!tool?.installed;
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[0.78125rem]">
      <Logo provider={provider} />
      <span className="text-foreground">{name}</span>
      <span className="ml-auto flex items-center gap-3">
        <Status tool={tool} />
        {!installed && tool && (
          <Button variant="learn" size="sm" onClick={onInstall} disabled={busy || locked}>
            {busy ? "Installing…" : "Install"}
          </Button>
        )}
      </span>
    </div>
  );
}

export function ToolRow({
  name,
  note,
  tool,
  busy,
  locked,
  onInstall,
}: {
  name: string;
  note: string;
  tool?: Tool;
  busy: boolean;
  locked: boolean;
  onInstall: () => void;
}) {
  const installed = !!tool?.installed;
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[0.78125rem]">
      <span className="font-medium text-foreground">{name}</span>
      <span className="truncate text-[0.71875rem] text-muted-foreground">{note}</span>
      <span className="ml-auto flex items-center gap-3">
        <Status tool={tool} />
        {!installed && tool && (
          <Button variant="learn" size="sm" onClick={onInstall} disabled={busy || locked}>
            {busy ? "Installing…" : "Install"}
          </Button>
        )}
      </span>
    </div>
  );
}

export function ImageRow({
  image,
  note,
  busy,
  locked,
  onPull,
}: {
  image: ProvisioningImage;
  note: string;
  busy: boolean;
  locked: boolean;
  onPull: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-[0.78125rem]">
      <span className="font-medium text-foreground">{image.name}</span>
      <span className="truncate text-[0.71875rem] text-muted-foreground">{note}</span>
      <span className="ml-auto flex items-center gap-3">
        <span className={cn("flex items-center gap-1.5", image.present ? "text-emerald-500" : "text-muted-foreground")}>
          {image.present && <span className="size-1.5 rounded-full bg-emerald-500" />}
          {image.present ? "pulled" : "not pulled"}
        </span>
        {!image.present && (
          <Button variant="learn" size="sm" onClick={onPull} disabled={busy || locked}>
            {busy ? "Pulling…" : "Pull"}
          </Button>
        )}
      </span>
    </div>
  );
}

// Azure and GCP can't run labs yet, so these rows don't offer an install or sign-in: the
// azure-cli brew formula alone compiles llvm + rust, a long build for a provider that does
// nothing here. Only AWS (CliRow) and Terraform are installable. Props kept so the call
// sites don't need to change when provisioning for these providers lands.

export function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[0.6875rem] font-semibold tabular-nums text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-[0.78125rem] font-medium">{title}</p>
        <p className="text-[0.71875rem] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
