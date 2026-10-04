"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/format";

/**
 * Auto-scrolling terminal for streamed command output: black body, and a header with a
 * title, a live elapsed timer, and a collapse toggle. The timer ticks while `running` and
 * freezes when it ends, so the header doubles as done / failed feedback (failure is a final
 * line starting with ✗). The component is remounted per run by its parent, so its timer
 * state resets naturally.
 */
export function LogConsole({
  lines,
  running = false,
  title = "Output",
  className,
}: {
  lines: string[];
  running?: boolean;
  title?: string;
  className?: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState<number>(() => Date.now());
  const [startAt, setStartAt] = useState<number | null>(null);

  // Keep the newest line in view: scroll the log body itself to the bottom (not the page) on
  // every new line, so it reads like a tail -f and never needs manual scrolling.
  useEffect(() => {
    const el = pre.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  // Tick only while running; setState happens in the async interval callback (not in the
  // effect body), and no refs are read during render.
  useEffect(() => {
    if (!running || lines.length === 0) return;
    const id = setInterval(() => {
      setNow(Date.now());
      setStartAt((s) => s ?? Date.now());
    }, 300);
    return () => clearInterval(id);
  }, [running, lines.length]);

  if (lines.length === 0) return null;

  const failed = !running && (lines.at(-1)?.trimStart().startsWith("✗") ?? false);
  const elapsed = startAt === null ? 0 : Math.max(0, now - startAt);

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-black", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-b border-border/70 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-learn" />
        ) : failed ? (
          <X className="size-3.5 text-rose-400" />
        ) : (
          <Check className="size-3.5 text-emerald-500" />
        )}
        <span className="text-[0.71875rem] font-medium text-foreground">{running ? `${title}…` : failed ? `${title} failed` : `${title} · done`}</span>
        <span className="ml-auto font-mono text-[0.6875rem] tabular-nums text-muted-foreground">{formatElapsed(elapsed)}</span>
        {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
      </button>
      {open && (
        <pre ref={pre} className="max-h-40 overflow-auto p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
