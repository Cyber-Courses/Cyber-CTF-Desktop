import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Staggered entrance (rise + fade), matching the website's FadeIn. CSS-only via the
 * `rise-in` keyframe; `delay` is in seconds and `fill: both` keeps it hidden until it runs.
 */
export function FadeIn({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <div className={cn("animate-rise-in", className)} style={{ animationDelay: `${delay}s`, animationFillMode: "both" } as CSSProperties}>
      {children}
    </div>
  );
}
