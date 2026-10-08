"use client";

import { cn } from "@/lib/utils";

/** A row of mutually exclusive options in one glass track (filters, view switches, small settings). */
export function Segmented<T extends string | number | null>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex items-center gap-0.5 rounded-control bg-glass p-[0.1875rem] shadow-[inset_0_0_0_1px_var(--border)]", className)}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-[0.4375rem] px-3 text-[0.75rem] transition-colors",
            value === o.value ? "bg-glass-2 text-foreground shadow-[inset_0_0_0_1px_var(--input)]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Filter chips: a selected chip is filled with ink. */
export function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "h-7 rounded-full px-3 text-[0.75rem] transition-colors",
        selected ? "bg-foreground text-background" : "bg-glass text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
