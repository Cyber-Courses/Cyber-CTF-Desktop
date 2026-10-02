"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** A small auto-scrolling terminal for streamed command output. */
export function LogConsole({ lines, className }: { lines: string[]; className?: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines]);
  if (lines.length === 0) return null;
  return (
    <pre className={cn("max-h-64 overflow-auto rounded-lg border border-border bg-[#0d0d0d] p-3 font-mono text-xs leading-relaxed text-muted-foreground", className)}>
      {lines.join("\n")}
      <div ref={end} />
    </pre>
  );
}
