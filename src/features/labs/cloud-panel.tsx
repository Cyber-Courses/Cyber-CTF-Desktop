"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { CopyValue } from "@/components/ui/copy-value";
import { Panel, PanelHeader } from "@/components/ui/panel";
import type { CloudPreview, LabOutput } from "@/lib/tauri";

/** "about $0.02 an hour (about $0.08 until it auto-stops in 4 h)" from a lab's own estimate. */
export function costEstimate(hourlyUsd: number | null | undefined, autoStopHours?: number | null): string | null {
  if (hourlyUsd == null) return null;
  const hourly = `about $${hourlyUsd.toFixed(2)} an hour`;
  return autoStopHours ? `${hourly} (about $${(hourlyUsd * autoStopHours).toFixed(2)} until it auto-stops in ${autoStopHours} h)` : hourly;
}

/**
 * Before a cloud lab starts, in the launch dialog: what it costs and what it does in the
 * player's account, so the click that spends money is an informed one.
 */
export function CloudLaunchNote({ preview, autoStopHours }: { preview: CloudPreview | null; autoStopHours: number | null }) {
  const cost = costEstimate(preview?.hourlyUsd, autoStopHours);
  return (
    <div className="space-y-1.5 rounded-panel bg-glass px-3.5 py-3 text-[0.75rem] leading-relaxed text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
      <p>
        <b className="text-foreground">Billed to your cloud account.</b> The lab creates its services there and they cost money until you stop it
        {autoStopHours ? ` or it auto-stops after ${autoStopHours} h` : ""}.
      </p>
      <p>{cost ? `Estimated cost: ${cost}. The lab's own estimate; your cloud bills the real amount.` : "This lab gives no cost estimate."}</p>
      {preview?.allowList && <p>It lets in your public IP only.</p>}
    </div>
  );
}

/** One output: copyable, a secret masked until asked. */
function OutputRow({ output }: { output: LabOutput }) {
  const [shown, setShown] = useState(!output.sensitive);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-[0.8125rem] first:border-t-0">
      <span className="shrink-0 font-mono text-[0.75rem] text-muted-foreground">{output.name}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {shown ? <CopyValue text={output.value} /> : <CopyValue text={output.value} label="••••••••" />}
        {output.sensitive && (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            className="text-faint transition-colors hover:text-foreground"
            aria-label={shown ? `Hide ${output.name}` : `Show ${output.name}`}
            title={shown ? "Hide" : "Show"}
          >
            {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * A running cloud lab: its own words (where to start) and what it exposes (its module's
 * outputs: addresses, keys). There is no network diagram: no machines, only services.
 */
export function CloudPanel({ message, outputs, where }: { message: string | null; outputs: LabOutput[]; where: string }) {
  return (
    <Panel>
      <PanelHeader title="Cloud services" meta={where} />
      {message && <p className="whitespace-pre-wrap px-4 py-3.5 font-mono text-[0.75rem] leading-relaxed text-foreground">{message}</p>}
      {outputs.length > 0 && (
        <div className={message ? "border-t border-border" : undefined}>
          {outputs.map((o) => (
            <OutputRow key={o.name} output={o} />
          ))}
        </div>
      )}
      {!message && outputs.length === 0 && (
        <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">The lab is up in your cloud account. It exposes nothing to show here.</p>
      )}
    </Panel>
  );
}
