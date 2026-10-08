import { cn } from "@/lib/utils";

/** A small indeterminate spinner that inherits the current text color. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70", className)}
    />
  );
}
