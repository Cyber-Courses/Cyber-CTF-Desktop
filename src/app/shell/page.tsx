"use client";

import "@xterm/xterm/css/xterm.css";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useIsMac } from "@/lib/platform";
import { labAttackShell, attackVmShell, terminalClose, terminalOpen, terminalResize, terminalWrite, type Runtime, type ShellKind } from "@/lib/tauri";

/** Reads a CSS custom property from the page, so the terminal follows the app's theme. */
const cssVar = (name: string, fallback: string) =>
  (typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

type State = { kind: "connecting" } | { kind: "open" } | { kind: "ended"; code: number | null } | { kind: "failed"; message: string };

/** The attack box shell window (opened by `terminal_window`): xterm.js over a pseudo-terminal. */
function Shell() {
  const t = useT();
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const kind = (params.get("kind") ?? "lab") as ShellKind;
  const runtime = (params.get("runtime") ?? "DOCKER") as Runtime;
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!host.current || !id) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: cssVar("--font-mono", "ui-monospace, monospace"),
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: cssVar("--background", "#09090b"),
        foreground: cssVar("--foreground", "#f4f4f6"),
        cursor: cssVar("--foreground", "#f4f4f6"),
        selectionBackground: "rgba(148, 163, 184, 0.35)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    term.focus();

    let session: number | null = null;
    let disposed = false;
    const input = term.onData((d) => {
      if (session !== null) void terminalWrite(session, d).catch(() => {});
    });
    const resized = term.onResize(({ cols, rows }) => {
      if (session !== null) void terminalResize(session, cols, rows).catch(() => {});
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);

    terminalOpen(id, kind, runtime, term.cols, term.rows, (e) => {
      if (e.kind === "data") term.write(e.data);
      else {
        session = null;
        if (!disposed) setState({ kind: "ended", code: e.code });
      }
    })
      .then((s) => {
        if (disposed) {
          void terminalClose(s);
          return;
        }
        session = s;
        setState((prev) => (prev.kind === "connecting" ? { kind: "open" } : prev));
      })
      .catch((err) => !disposed && setState({ kind: "failed", message: String(err) }));

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      resized.dispose();
      if (session !== null) void terminalClose(session);
      term.dispose();
    };
  }, [id, kind, runtime, attempt]);

  const reconnect = useCallback(() => {
    setState({ kind: "connecting" });
    setAttempt((a) => a + 1);
  }, []);
  // The system terminal, for players who prefer theirs.
  const openOutside = () => void (kind === "attackVm" ? attackVmShell(id) : labAttackShell(id, runtime)).catch(() => {});

  // macOS overlays the traffic lights on this bar; elsewhere the window has its own title bar.
  const isMac = useIsMac();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Overlay title bar: drags the window and clears the macOS traffic lights. */}
      <div
        data-tauri-drag-region
        className={`flex h-11 shrink-0 select-none items-center justify-end gap-1 border-b border-border pr-3 ${isMac ? "pl-20" : "pl-4"}`}
      >
        <span data-tauri-drag-region className="mr-auto truncate font-mono text-[0.75rem] text-muted-foreground">
          {state.kind === "connecting"
            ? t("shell.terminal.connecting")
            : state.kind === "open"
              ? t("shell.terminal.open")
              : state.kind === "ended"
                ? t("shell.terminal.ended")
                : t("shell.terminal.failed")}
        </span>
        <Button variant="ghost" size="sm" onClick={openOutside} title={t("shell.terminal.systemTerminalHint")}>
          <SquareTerminal className="size-3.5" /> {t("shell.terminal.systemTerminal")}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 p-2">
        <div ref={host} className="h-full w-full" />
        {(state.kind === "ended" || state.kind === "failed") && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-2.5 text-[0.8125rem]">
            <span className={state.kind === "failed" ? "text-destructive" : "text-muted-foreground"}>
              {state.kind === "failed"
                ? state.message
                : state.code
                  ? t("shell.terminal.shellEndedWithCode", { code: state.code })
                  : t("shell.terminal.shellEnded")}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={reconnect}>
                <RotateCw className="size-3.5" /> {t("shell.terminal.reconnect")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void getCurrentWindow().close()}>
                {t("shell.terminal.close")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ShellWindow() {
  return (
    <Suspense>
      <Shell />
    </Suspense>
  );
}
