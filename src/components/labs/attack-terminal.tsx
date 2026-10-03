"use client";

import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

/**
 * An embedded xterm.js terminal attached to the lab's Exegol attack box. The Rust
 * side runs `docker exec -it <exegol> zsh` under a PTY and streams bytes here
 * (base64); keystrokes go back via exegol_shell_write. One shell per lab.
 */
export function AttackTerminal({ labId }: { labId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;

      const term = new Terminal({
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontSize: 12.5,
        cursorBlink: true,
        theme: {
          background: "#070707",
          foreground: "#ededed",
          cursor: "#a78bfa",
          selectionBackground: "#2a2a2a",
          black: "#0a0a0a",
          brightBlack: "#5a5a5a",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();

      const output = new Channel<string>();
      output.onmessage = (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        term.write(bytes);
      };

      await invoke("exegol_shell_open", { id: labId, cols: term.cols, rows: term.rows, output });
      term.focus();

      const offData = term.onData((d) => invoke("exegol_shell_write", { id: labId, data: d }).catch(() => {}));

      const refit = () => {
        fit.fit();
        invoke("exegol_shell_resize", { id: labId, cols: term.cols, rows: term.rows }).catch(() => {});
      };
      const ro = new ResizeObserver(refit);
      ro.observe(host.current);

      dispose = () => {
        ro.disconnect();
        offData.dispose();
        invoke("exegol_shell_close", { id: labId }).catch(() => {});
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [labId]);

  return <div ref={host} className="h-[360px] w-full overflow-hidden rounded-b-xl bg-[#070707] p-2" />;
}
