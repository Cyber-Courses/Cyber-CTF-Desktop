"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/lib/use-focus-trap";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  /** Heading the command is listed under (Screens, Labs...). */
  group?: string;
  run: () => void;
};

/**
 * ⌘K / Ctrl+K command palette: fuzzy-filter a flat list of actions (navigate, open settings,
 * find a lab…), arrow keys to move, Enter to run, Esc to close. Rendered by the app shell, which
 * owns open/close; this component owns the query, selection and keyboard handling while open.
 */
export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // A modal: Tab stays in the palette instead of reaching the page behind it, and focus goes
  // back where it was when it closes.
  useFocusTrap(dialogRef, open);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q));
  }, [query, commands]);

  // The selection, kept in range as results shrink (clamped during render, not in an effect).
  const selected = Math.min(active, Math.max(0, results.length - 1));

  // Focus the field when it appears, and keep the selected row visible: DOM side effects only.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-active=true]")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(results.length ? (selected + 1) % results.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(results.length ? (selected - 1 + results.length) % results.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[selected]);
    }
  };

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] pt-[14vh] backdrop-blur-[3px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className="surface-glass w-full max-w-[36rem] overflow-hidden rounded-[1rem]"
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search labs, screens, actions…"
            className="h-13 w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-faint"
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[24rem] overflow-y-auto pb-2">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-[0.8125rem] text-muted-foreground">No results</p>
          ) : (
            results.map((c, i) => {
              const Icon = c.icon;
              const heading = c.group && c.group !== results[i - 1]?.group ? c.group : null;
              return (
                <div key={c.id}>
                  {heading && <div className="section-label px-4 pt-3 pb-1.5">{heading}</div>}
                  <button
                    type="button"
                    data-active={i === selected}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(c)}
                    className={cn(
                      "flex h-9 w-full items-center gap-3 px-4 text-left text-[0.8125rem] transition-colors",
                      i === selected ? "bg-glass-2 text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0 text-faint" />
                    <span className="flex-1 truncate">{c.label}</span>
                    {c.hint && <span className="truncate font-mono text-[0.625rem] text-faint">{c.hint}</span>}
                    {i === selected && <CornerDownLeft className="size-3.5 shrink-0 text-faint" />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
