"use client";

import { type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, Cloud, ExternalLink, Server } from "lucide-react";
import { type RemoteProvider } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Proxmox's own logo (official media kit, unaltered), or a neutral mark for ESXi / AWS. */
export function HypervisorMark({ provider }: { provider: RemoteProvider }) {
  if (provider === "aws")
    return (
      <span className="flex h-5 items-center gap-1.5 text-[0.8125rem] font-semibold tracking-tight">
        <Cloud className="size-4 text-muted-foreground" /> Amazon Web Services
      </span>
    );
  if (provider === "proxmox")
    // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
    return <img src="/brands/proxmox-full-lockup-inverted-color.svg" alt="Proxmox" className="h-5 w-auto" draggable={false} />;
  // VMware/Broadcom logos need Broadcom's approval, so ESXi gets a neutral mark until then.
  return (
    <span className="flex h-5 items-center gap-1.5 text-[0.8125rem] font-semibold tracking-tight">
      <Server className="size-4 text-muted-foreground" /> VMware ESXi
    </span>
  );
}

/** Trademark line, shown pinned at the bottom of the setup window. */
export function SetupTrademarks({ cloud = false }: { cloud?: boolean }) {
  if (cloud) {
    return (
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground/70">
        Amazon Web Services and AWS are trademarks of Amazon.com, Inc. Microsoft Azure and Google Cloud are trademarks of their respective owners. Cyber CTF
        isn&apos;t affiliated with any of them.
      </p>
    );
  }
  return (
    <p className="text-[0.6875rem] leading-relaxed text-muted-foreground/70">
      Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.{" "}
      <button
        onClick={() => openUrl("https://www.proxmox.com").catch(() => {})}
        className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
      >
        proxmox.com <ExternalLink className="size-3" />
      </button>{" "}
      VMware and ESXi are trademarks of Broadcom. Cyber CTF isn&apos;t affiliated with any of them.
    </p>
  );
}

export function Step({ icon: Icon, title, description, children }: { icon: typeof Server; title: string; description: string; children: ReactNode }) {
  return (
    // mt-2 separates the icon row from the "Step N of M" line above it, as in machine-setup.
    <div className="mt-2">
      <div className="flex items-start gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
          <Icon className="size-5 text-foreground" />
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-[0.78125rem] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-6">{children}</div>
    </div>
  );
}

export function Nav({ left, right }: { left?: ReactNode; right: ReactNode }) {
  return (
    <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline gap-2 text-[0.75rem] text-muted-foreground">
        {label}
        {hint && <span className="text-[0.6875rem] text-muted-foreground/60">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      spellCheck={false}
      {...props}
      className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring"
    />
  );
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          "w-full cursor-pointer appearance-none rounded-md border border-border bg-card px-3 py-2 pr-9 text-[0.8125rem] text-foreground outline-none transition-colors hover:border-ring/60 focus:border-ring",
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
