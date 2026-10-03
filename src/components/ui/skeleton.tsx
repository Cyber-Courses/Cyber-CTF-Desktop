import { cn } from "@/lib/utils";

/** A shimmering placeholder block for loading states. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}
