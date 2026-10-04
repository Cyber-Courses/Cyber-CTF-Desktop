"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ layout */

export function Section({ title, description, saved, children }: { title: string; description?: string; saved?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4 px-0.5">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{description}</p>}
        </div>
        <span
          aria-live="polite"
          className={cn("flex items-center gap-1 text-xs text-emerald-500 transition-opacity duration-300", saved ? "opacity-100" : "opacity-0")}
        >
          <Check className="size-3.5" /> Saved
        </span>
      </div>
      <Card className="divide-y divide-border">{children}</Card>
    </section>
  );
}

/** One setting: label + description on the left, its control on the right (or below, when `stacked`). */
export function Row({
  title,
  description,
  control,
  stacked,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  stacked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="px-5 py-4">
      <div className={cn("flex gap-6", stacked ? "flex-col gap-3" : "items-center justify-between")}>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">{description}</div>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/** Flashes the section's "Saved" mark for a moment after a change. */
export function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return [
    saved,
    () => {
      setSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 1600);
    },
  ];
}

export function OptionRow({
  selected,
  onSelect,
  title,
  subtitle,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  subtitle: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer gap-3 border-b border-border px-3.5 py-3 outline-none transition-colors last:border-0 focus-visible:bg-muted",
        selected ? "bg-learn/[0.06]" : "hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-learn" : "border-muted-foreground/40",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-learn" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] font-medium text-foreground">{title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
        {children}
      </div>
    </div>
  );
}
