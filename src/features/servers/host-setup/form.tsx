"use client";

import { type ReactNode } from "react";
import { ChevronDown, Cloud, ExternalLink, Server } from "lucide-react";
import { type RemoteProvider } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { openExternal } from "@/lib/failure";
import { fieldClass } from "@/components/ui/input";

/** Proxmox's own icon mark (official media kit, unaltered), or a neutral mark for ESXi / AWS. */
export function HypervisorMark({ provider }: { provider: RemoteProvider }) {
  if (provider === "proxmox")
    // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
    return <img src="/brands/proxmox-icon.svg" alt="" className="size-5 object-contain" draggable={false} />;
  // VMware/Broadcom logos need Broadcom's approval, so ESXi gets a neutral mark until then.
  if (provider === "aws") return <Cloud className="size-4" />;
  return <Server className="size-4" />;
}

/** Trademark line, shown pinned at the bottom of the setup window. */
export function SetupTrademarks({ cloud = false }: { cloud?: boolean }) {
  if (cloud) {
    return (
      <p className="text-[0.6875rem] leading-relaxed text-faint">
        Amazon Web Services and AWS are trademarks of Amazon.com, Inc. Microsoft Azure and Google Cloud are trademarks of their respective owners. Cyber CTF
        isn&apos;t affiliated with any of them.
      </p>
    );
  }
  return (
    <p className="text-[0.6875rem] leading-relaxed text-faint">
      Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.{" "}
      <button
        onClick={() => openExternal("https://www.proxmox.com")}
        className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-muted-foreground hover:underline"
      >
        proxmox.com <ExternalLink className="size-3" />
      </button>{" "}
      VMware and ESXi are trademarks of Broadcom. Cyber CTF isn&apos;t affiliated with any of them.
    </p>
  );
}

export function Step({ icon: Icon, title, description, children }: { icon: typeof Server; title: string; description: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="flex items-start gap-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-glass-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--input)]">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[1rem] font-medium tracking-tight text-foreground">{title}</h2>
          <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
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
    <label className="block space-y-1.5">
      <span className="flex items-baseline gap-2 text-[0.75rem] font-medium text-muted-foreground">
        {label}
        {hint && <span className="text-[0.6875rem] font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** A wizard text field: the shared glass field, mono by default (hosts, keys, ids). */
export function Input({ mono = true, className, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input spellCheck={false} {...props} className={cn(fieldClass("default", mono), className)} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select {...props} className={cn(fieldClass(), "cursor-pointer appearance-none pr-9", className)}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-faint" />
    </div>
  );
}

/** A quiet inline box in a step (sign-in state, a key to copy): glass with a hairline ring. */
export function Note({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-control bg-glass px-3 py-2.5 text-[0.75rem] shadow-[inset_0_0_0_1px_var(--border)]", className)}>{children}</div>;
}

/** A provider mark in a small glass tile, leading a pick-one row. */
export function MarkTile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-8 place-items-center rounded-control bg-glass-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--input)]">{children}</span>
  );
}
