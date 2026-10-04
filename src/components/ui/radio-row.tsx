"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One option in a pick-one list (rows inside a bordered box). `compact` is the dense form
 * used in popovers; a disabled row stays visible and says why through `subtitle`/`hint`.
 */
export function RadioRow({
  selected,
  onSelect,
  title,
  subtitle,
  disabled,
  hint,
  compact,
  leading,
  trailing,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  subtitle: ReactNode;
  disabled?: boolean;
  /** Tooltip, e.g. why the option can't be picked. */
  hint?: string;
  compact?: boolean;
  /** A mark before the text (e.g. a provider logo). */
  leading?: ReactNode;
  /** Right-aligned extra (e.g. a status pill). */
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const pick = () => !disabled && onSelect();
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      title={hint}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      }}
      className={cn(
        "flex gap-3 border-b border-border outline-none transition-colors last:border-0 focus-visible:bg-muted",
        compact ? "px-3 py-2" : "px-3.5 py-3",
        disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
        selected ? "bg-learn/[0.06]" : !disabled && "hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex shrink-0 items-center justify-center rounded-full border transition-colors",
          compact ? "size-3.5" : "size-4",
          selected ? "border-learn" : "border-muted-foreground/40",
        )}
      >
        {selected && <span className={cn("rounded-full bg-learn", compact ? "size-1.5" : "size-2")} />}
      </span>
      {leading && <span className="-my-0.5 shrink-0">{leading}</span>}
      <div className="min-w-0 flex-1">
        <div className={cn("flex flex-wrap items-center gap-1.5 font-medium text-foreground", compact ? "text-[0.78125rem]" : "text-[0.8125rem]")}>{title}</div>
        <div className={cn("mt-0.5 truncate text-muted-foreground", compact ? "font-mono text-[0.65625rem]" : "text-xs")}>{subtitle}</div>
        {children}
      </div>
      {trailing && <span className="shrink-0 self-center">{trailing}</span>}
    </div>
  );
}

/** The bordered box that holds a list of RadioRows. */
export function RadioList({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("overflow-hidden rounded-lg border border-border", className)}>
      {children}
    </div>
  );
}
