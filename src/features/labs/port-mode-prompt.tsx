"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Plug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioList, RadioRow } from "@/components/ui/radio-row";
import { Switch } from "@/components/ui/switch";
import { setPortMode, type PortMode } from "@/lib/settings";
import { useFocusTrap } from "@/lib/use-focus-trap";

// Before a container lab starts on this machine: random host ports, or the lab's own ones.
// `askPortMode` opens the dialog (mounted once, in the app shell) and resolves with the choice,
// or null when the player cancels.

type Ask = { id: number; title: string; resolve: (mode: PortMode | null) => void };

let current: Ask | null = null;
let asked = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function askPortMode(title: string): Promise<PortMode | null> {
  // A second start while the dialog is open answers the first one with a cancel.
  current?.resolve(null);
  return new Promise((resolve) => {
    current = { id: ++asked, title, resolve };
    emit();
  });
}

function answer(mode: PortMode | null) {
  const ask = current;
  current = null;
  emit();
  ask?.resolve(mode);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function PortModePrompt() {
  const ask = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  // Keyed per request so each one starts on the recommended choice.
  return ask ? <Dialog key={ask.id} title={ask.title} /> : null;
}

function Dialog({ title }: { title: string }) {
  const [mode, setMode] = useState<PortMode>("random");
  const [remember, setRemember] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEffect(() => {
    // Escape is the dialog's alone (the lab page goes back to the list on it).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      answer(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const start = () => {
    if (remember) setPortMode(mode);
    answer(mode);
  };

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && answer(null)}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ports-title"
        className="surface-glass w-full max-w-[30rem] rounded-[1rem] p-5 outline-none"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-control bg-jewel/10 text-jewel-text shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--jewel)_30%,transparent)]">
            <Plug className="size-4" />
          </span>
          <div className="min-w-0">
            <p id="ports-title" className="text-[0.9375rem] font-medium text-foreground">
              Which ports should {title} use?
            </p>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">Where its services answer on this machine.</p>
          </div>
        </div>

        <PortChoice value={mode} onChange={setMode} className="mt-4" />

        <label className="mt-4 flex cursor-pointer items-center justify-between gap-3 text-[0.8125rem] text-muted-foreground">
          <span>
            Use this for every lab <span className="text-faint">· change it in Settings › Labs</span>
          </span>
          <Switch aria-label="Use this for every lab" checked={remember} onCheckedChange={setRemember} />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button size="sm" onClick={start}>
            Start lab
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Random free ports, or the lab's own ones with the collision warning. Also in "Where should it run?". */
export function PortChoice({ value, onChange, className }: { value: PortMode; onChange: (mode: PortMode) => void; className?: string }) {
  return (
    <RadioList label="Host ports" className={className}>
      <RadioRow
        selected={value === "random"}
        onSelect={() => onChange("random")}
        title={
          <>
            Random ports <Badge>Recommended</Badge>
          </>
        }
        subtitle="A free port per service, like :64645. Never collides."
      />
      <RadioRow
        selected={value === "default"}
        onSelect={() => onChange("default")}
        title="The lab's default ports"
        subtitle="Each service on its own port, like CTFd on :8000."
      >
        {value === "default" && (
          <p className="mt-2 flex items-start gap-2 rounded-control bg-warning/10 px-2.5 py-2 text-[0.75rem] leading-relaxed text-warning shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_30%,transparent)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              These ports may already be taken by another lab or app (a local web server on 8000 or 3000, say). That is only known once the lab is downloaded:
              the start then stops and names the port in use. Two services on the same port inside the lab: the second gets a random one.
            </span>
          </p>
        )}
      </RadioRow>
    </RadioList>
  );
}
