"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { tell } from "@/lib/failure";

/** A value with a one-click copy. Shows a check for a moment after copying. `label` is what is
 *  displayed when it should differ from the copied `text` (e.g. show `:56235`, copy the full
 *  `http://127.0.0.1:56235`). */
export function CopyValue({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${text}`}
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(tell("Couldn't copy to the clipboard"))
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xs bg-glass px-1.5 py-0.5 font-mono text-[0.75rem] text-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-glass-2",
        className,
      )}
    >
      <span className="break-all">{label ?? text}</span>
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3 text-faint" />}
    </button>
  );
}
