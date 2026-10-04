import type { ReactNode } from "react";

/** The square icon tile at the start of a list row. */
export function TypeIcon({ children }: { children: ReactNode }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground">{children}</span>;
}
