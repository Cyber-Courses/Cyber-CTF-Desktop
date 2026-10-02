import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The family Button primitive, monochrome Geist. Token-driven so it matches the rest of
 * the Cyber apps. Dependency-free (no cva/base-ui) to keep the launcher light.
 */
type Variant = "default" | "learn" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type Size = "default" | "sm" | "lg" | "icon";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm font-medium leading-none whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const VARIANTS: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  learn: "bg-learn text-white hover:bg-learn/90",
  outline: "border border-border bg-background hover:bg-muted hover:text-foreground",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-muted hover:text-foreground",
  destructive: "bg-destructive/15 text-destructive hover:bg-destructive/25",
  link: "text-link underline-offset-4 hover:underline",
};

const SIZES: Record<Size, string> = {
  default: "h-9 px-4",
  sm: "h-8 px-3 text-[0.8rem]",
  lg: "h-10 px-5",
  icon: "size-9",
};

export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

export function Button({
  variant = "default",
  size = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button className={buttonVariants({ variant, size, className })} {...props} />;
}
