"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Card with a cursor-following spotlight in the --learn tint, matching
 * cyber-courses-web's MagicCard. Dependency-free: the pointer position is written to
 * CSS variables and a radial-gradient overlay fades in on hover.
 */
export function MagicCard({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onClick={onClick}
      className={cn("group relative overflow-hidden rounded-xl border border-border bg-card transition-colors duration-200 hover:border-ring/50", className)}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: "radial-gradient(240px circle at var(--mx, 50%) var(--my, 0%), color-mix(in oklab, var(--learn) 16%, transparent), transparent 70%)",
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
