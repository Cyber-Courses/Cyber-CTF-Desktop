import { cn } from "@/lib/utils";

/** A dependency-free on/off switch on the family tokens (accent when on). */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...props
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
        checked ? "bg-learn" : "bg-muted-foreground/30",
        className,
      )}
      {...props}
    >
      <span className={cn("inline-block size-4 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}
