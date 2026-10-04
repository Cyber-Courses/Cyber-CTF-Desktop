"use client";

import { useEffect, useRef } from "react";
import { type ServerHost } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const HYPERVISOR: Record<string, string> = { vmware_esxi: "ESXi", proxmox: "Proxmox", aws: "AWS, billed to you" };

/** A small card under the Start button. Escape or a click outside closes it. */
export function RunOnPopover({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    document.addEventListener("keydown", onKey);
    // Next tick, so the click that opened it doesn't close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown));
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Run on"
      className="absolute right-0 top-full z-20 mt-2 w-[18rem] rounded-xl border border-border bg-card p-3 shadow-xl shadow-black/40"
    >
      {children}
    </div>
  );
}

/** "Run on: this machine | <server host>". Hosts the lab can't run on are disabled. */
export function RunOnPicker({
  hosts,
  hostOk,
  localNote,
  value,
  onChange,
  disabled,
}: {
  hosts: ServerHost[];
  hostOk: (h: ServerHost) => boolean;
  localNote: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled: boolean;
}) {
  const options = [
    { id: null as string | null, label: "This machine", note: localNote, ok: true },
    ...hosts.map((h) => ({ id: h.id as string | null, label: h.name, note: `${HYPERVISOR[h.provider]} · ${h.host}`, ok: hostOk(h) })),
  ];
  return (
    <div className="space-y-1.5">
      <p className="text-[0.75rem] font-medium text-foreground">Where should it run?</p>
      <div className="overflow-hidden rounded-lg border border-border">
        {options.map((o) => {
          const selected = value === o.id;
          return (
            <button
              key={o.id ?? "local"}
              type="button"
              disabled={disabled || !o.ok}
              onClick={() => onChange(o.id)}
              title={o.ok ? undefined : `This lab doesn't support ${o.note.split(" · ")[0]}`}
              className={cn(
                "flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0 transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                selected ? "bg-muted" : "hover:bg-muted/50",
              )}
            >
              <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border", selected ? "border-learn" : "border-muted-foreground/40")}>
                {selected && <span className="size-1.5 rounded-full bg-learn" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{o.label}</span>
                <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{o.ok ? o.note : "Not supported by this lab"}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
