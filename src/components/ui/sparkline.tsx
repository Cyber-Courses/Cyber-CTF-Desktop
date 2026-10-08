import { cn } from "@/lib/utils";

/**
 * A tiny area chart for stat cards (CPU, memory). Values are 0 to 100; the last point is
 * marked. Uses the jewel, or the warning colour when `warn`.
 */
export function Sparkline({ values, warn, className }: { values: number[]; warn?: boolean; className?: string }) {
  const w = 160;
  const h = 36;
  const pts = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const step = w / (pts.length - 1);
  const y = (v: number) => (h - (Math.max(0, Math.min(100, v)) / 100) * (h - 3) - 1.5).toFixed(1);
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${y(v)}`).join(" ");
  const color = warn ? "var(--warning)" : "var(--jewel)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className={cn("h-9 w-full", className)}>
      <polyline points={`0,${h} ${line} ${w},${h}`} style={{ fill: color }} fillOpacity={0.12} stroke="none" />
      <polyline points={line} fill="none" style={{ stroke: color }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
