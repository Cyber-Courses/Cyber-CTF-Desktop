"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-pill";
import { type CloudProvider, type ProvisioningImage, type Tool } from "@/lib/tauri";
import { LogoTile, Status } from "@/features/cloud/account-row";

/** A dense tool row: optional logo, name over a note, then the mono status and an xs action. */
function Row({ lead, name, note, status, action }: { lead?: ReactNode; name: string; note?: string; status: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-[3.25rem] items-center gap-3.5 border-t border-border px-4 py-2 transition-colors first:border-t-0 hover:bg-glass">
      {lead}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.8125rem] font-medium text-foreground">{name}</p>
        {note && <p className="truncate text-[0.75rem] text-muted-foreground">{note}</p>}
      </div>
      <span className="flex shrink-0 items-center gap-3">
        {status}
        {action}
      </span>
    </div>
  );
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
    <Row
      lead={<LogoTile provider={provider} />}
      name={name}
      status={<Status tool={tool} />}
      action={
        !installed &&
        tool && (
          <Button variant="outline" size="xs" onClick={onInstall} disabled={busy || locked}>
            {busy ? "Installing…" : "Install"}
          </Button>
        )
      }
    />
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
    <Row
      name={name}
      note={note}
      status={<Status tool={tool} />}
      action={
        !installed &&
        tool && (
          <Button variant="outline" size="xs" onClick={onInstall} disabled={busy || locked}>
            {busy ? "Installing…" : "Install"}
          </Button>
        )
      }
    />
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
    <Row
      name={image.name}
      note={note}
      status={
        <span className="flex items-center gap-2 font-mono text-[0.6875rem] text-faint">
          <StatusDot tone={image.present ? "ok" : "muted"} />
          {image.present ? "pulled" : "not pulled"}
        </span>
      }
      action={
        !image.present && (
          <Button variant="outline" size="xs" onClick={onPull} disabled={busy || locked}>
            {busy ? "Pulling…" : "Pull"}
          </Button>
        )
      }
    />
  );
}

// Azure and GCP can't run labs yet, so these rows don't offer an install or sign-in: the
// azure-cli brew formula alone compiles llvm + rust, a long build for a provider that does
// nothing here. Only AWS (CliRow) and Terraform are installable. Props kept so the call
// sites don't need to change when provisioning for these providers lands.

/** A numbered step row (the mockup's `.st`): a ringed number, the title, then a note. */
export function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-3 border-t border-border px-4 py-2.5 text-left first:border-t-0">
      <span className="mt-px grid size-[1.1rem] place-items-center rounded-full font-mono text-[0.625rem] text-muted-foreground tabular-nums shadow-[inset_0_0_0_1px_var(--input)]">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium text-foreground">{title}</p>
        <p className="text-[0.75rem] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
