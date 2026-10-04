"use client";

import { cn } from "@/lib/utils";

// Pick one of several equivalent options, as a grid of cards (e.g. container engines).

export function ChoiceGrid({ children }: { children: React.ReactNode }) {
  return (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
      {children}
    </div>
  );
}

/** One option: selecting it shows its install / status below, the others stay alternatives. */
export function Choice({
  selected,
  onSelect,
  mark,
  title,
  note,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  mark: React.ReactNode;
  title: string;
  note: string;
  badge?: "in use" | "running" | "installed" | "recommended";
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-foreground/40 bg-foreground/[0.04]" : "border-border hover:border-foreground/20",
      )}
    >
      {mark}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[0.8125rem] font-medium text-foreground">
          {title}
          {badge && (
            <span
              className={cn(
                "rounded px-1.5 py-px text-[0.65625rem] font-normal",
                badge === "recommended"
                  ? "border border-border text-muted-foreground"
                  : badge === "running"
                    ? "border border-emerald-500/30 text-emerald-500"
                    : "bg-emerald-500/10 text-emerald-500",
              )}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[0.75rem] text-muted-foreground">{note}</span>
      </span>
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-foreground" : "border-border")}>
        {selected && <span className="size-2 rounded-full bg-foreground" />}
      </span>
    </button>
  );
}

/** What to do for the selected option: install it, get it, or nothing (it's ready). */
export function ChoiceAction({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left">{children}</div>;
}
