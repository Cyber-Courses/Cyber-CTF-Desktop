import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A bordered surface with an optional header row, the density unit for rails and lists. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>{children}</div>;
}

export function PanelHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
      <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/** Small section label above a panel (e.g. "This machine", "Running now"). */
export function RailLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span className="text-[12.5px] font-medium text-foreground">{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}
