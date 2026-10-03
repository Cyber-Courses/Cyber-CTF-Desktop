import { cn } from "@/lib/utils";

/** A thin usage bar. Colors by load: calm under 75%, amber to 90%, red above. */
export function Meter({ value, className }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const tone = v > 90 ? "bg-rose-500" : v > 75 ? "bg-amber-500" : "bg-learn";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${v}%` }} />
    </div>
  );
}
