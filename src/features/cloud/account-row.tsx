"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, Pencil, Trash2, X, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type ServerHost, type ServerTest, type Tool } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export function AccountRow({
  host,
  test,
  spent,
  onTest,
  onEdit,
  onRemove,
}: {
  host: ServerHost;
  test: ServerTest | "testing" | undefined;
  spent?: number | null;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const result = test && test !== "testing" ? test : null;
  const ok = result ? result.ok : null;
  const [confirming, setConfirming] = useState(false);
  const facts = [
    host.host,
    host.provider === "digitalocean" || host.provider === "linode"
      ? "API token"
      : host.provider === "oci"
        ? "API key"
        : host.provider !== "aws"
          ? "CLI sign-in"
          : host.useCliCreds
            ? host.awsProfile
              ? `CLI · ${host.awsProfile}`
              : "CLI credentials"
            : "access keys",
    host.autoStopHours ? `auto-stop ${host.autoStopHours}h` : "no auto-stop",
  ];
  return (
    <div className="border-b border-border px-3.5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export, plain asset */}
        <img src={`/brands/${host.provider}.svg`} alt="" className="size-6 shrink-0" draggable={false} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[0.8125rem] font-medium">
            <span className="truncate">{host.name}</span>
            <span className={cn("size-1.5 shrink-0 rounded-full", ok === null ? "bg-muted-foreground/40" : ok ? "bg-emerald-500" : "bg-rose-500")} />
          </p>
          <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
            {facts.join(" · ")}
            {result?.latencyMs != null ? ` · ${result.latencyMs} ms` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {confirming ? (
            <>
              <span className="mr-1 text-[0.71875rem] text-muted-foreground">Remove?</span>
              <Button variant="destructive" size="sm" onClick={onRemove}>
                Remove
              </Button>
              <IconButton label="Cancel" onClick={() => setConfirming(false)}>
                <X className="size-3.5" />
              </IconButton>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onTest} disabled={test === "testing"}>
                {test === "testing" ? <Spinner className="size-3.5" /> : <Zap className="size-3.5" />} Test
              </Button>
              <IconButton label="Edit" onClick={onEdit}>
                <Pencil className="size-3.5" />
              </IconButton>
              <IconButton label="Remove" onClick={() => setConfirming(true)}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </>
          )}
        </div>
      </div>
      {result && (
        <p className={cn("mt-2 flex items-start gap-1.5 pl-9 text-[0.75rem]", ok ? "text-emerald-500" : "text-rose-400")}>
          {ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
          <span>{result.message}</span>
        </p>
      )}
      {host.monthlyLimit != null && (
        <p className={cn("mt-1.5 pl-9 text-[0.71875rem]", spent != null && spent >= host.monthlyLimit ? "text-rose-400" : "text-muted-foreground")}>
          Budget ${host.monthlyLimit.toFixed(0)}/mo{spent != null ? ` · $${spent.toFixed(2)} this month` : ""}
          {spent != null && spent >= host.monthlyLimit ? " — over budget" : ""}
        </p>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

export function Status({ tool }: { tool?: Tool }) {
  const installed = !!tool?.installed;
  return (
    <span className={cn("flex items-center gap-1.5 text-[0.75rem]", installed ? "text-emerald-500" : "text-muted-foreground")}>
      {installed && <span className="size-1.5 rounded-full bg-emerald-500" />}
      {tool ? (installed ? (tool.version ?? "installed") : "not installed") : "…"}
    </span>
  );
}
