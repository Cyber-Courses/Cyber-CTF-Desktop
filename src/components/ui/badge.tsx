import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "success" | "warning" | "accent" | "outline";

const VARIANTS: Record<Variant, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-emerald-500/12 text-emerald-500",
  warning: "bg-amber-500/12 text-amber-500",
  accent: "bg-learn/12 text-learn",
  outline: "border border-border text-muted-foreground",
};

/** Small status/label chip. Set `dot` for a leading status dot (uses currentColor). */
export function Badge({
  variant = "default",
  dot = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant; dot?: boolean }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.7rem] font-medium whitespace-nowrap", VARIANTS[variant], className)}
      {...props}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
