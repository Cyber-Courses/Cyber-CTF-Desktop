"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
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

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q));
  }, [query, commands]);

  // The selection, kept in range as results shrink (clamped during render, not in an effect).
  const selected = Math.min(active, Math.max(0, results.length - 1));

  // Focus the field when it appears, and keep the selected row visible — DOM side effects only.
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px] animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground/70" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Go to… or search actions"
            className="w-full bg-transparent py-3 text-[0.875rem] outline-none placeholder:text-muted-foreground/50"
          />
          <kbd className="rounded border border-border px-1.5 text-[0.625rem] text-muted-foreground/60">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[22rem] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[0.8125rem] text-muted-foreground">No matching action.</p>
          ) : (
            results.map((c, i) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.id}
                  data-active={i === selected}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.8125rem] transition-colors",
                    i === selected ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="truncate text-[0.71875rem] text-muted-foreground/70">{c.hint}</span>}
                  {i === selected && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground/60" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
