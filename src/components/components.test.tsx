// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlaskConical, Server } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, type Command } from "@/components/command-palette";
import { ErrorBoundary, ErrorScreen } from "@/components/error-screen";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Markdown } from "@/components/ui/markdown";
import { LogConsole } from "@/components/ui/log-console";
import { askPortMode, PortModePrompt } from "@/features/labs/port-mode-prompt";
import { ServerSelfTest } from "@/features/servers/server-self-test";
import { getPortMode } from "@/lib/settings";
import { commands, installTauri, stream } from "@/test/tauri";
import { flush } from "@/test/ui";

describe("Markdown", () => {
  const doc = [
    "# Title",
    "## Section",
    "### Sub",
    "Some **bold**, *italic*, `code` and a [link](https://cyberctf.org).",
    "still the same paragraph",
    "",
    "```bash",
    "nmap -sV 10.0.0.5",
    "```",
    "",
    "---",
    "> a quote",
    "> on two lines",
    "",
    "- one",
    "* two",
    "",
    "1. first",
    "2. second",
  ].join("\n");

  it("renders the common subset as elements", () => {
    render(<Markdown content={doc} className="prose" />);
    // One level down: the page's own title is the h1.
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Section" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Sub" })).toBeTruthy();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("nmap -sV 10.0.0.5")).toBeTruthy();
    expect(document.querySelector("hr")).not.toBeNull();
    expect(document.querySelector("blockquote")?.textContent).toContain("a quote");
    expect(document.querySelectorAll("ul li")).toHaveLength(2);
    expect(document.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("opens links in the player's browser, never in the app", async () => {
    const calls = installTauri();
    const user = userEvent.setup();
    render(<Markdown content="See [the docs](https://cyberctf.org/docs)." />);
    await user.click(screen.getByText("the docs"));
    await flush();
    expect(calls.find((c) => c.cmd === "plugin:opener|open_url")?.args).toMatchObject({ url: "https://cyberctf.org/docs" });
  });

  it("never injects HTML", () => {
    render(<Markdown content={"<img src=x onerror=alert(1)>"} />);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("LogConsole", () => {
  it("shows the lines, with failures and successes marked", () => {
    render(<LogConsole lines={["Pulling image", "✓ Started", "✗ Port 8080 is taken"]} />);
    expect(screen.getByText(/Pulling image/)).toBeTruthy();
    expect(screen.getByText(/Port 8080 is taken/)).toBeTruthy();
  });
});

describe("ErrorScreen and ErrorBoundary", () => {
  it("shows the error with a retry and copies the details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    const user = userEvent.setup();
    // After setup: user-event installs its own clipboard.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const err = Object.assign(new Error("lab_status failed"), { digest: "abc123" });
    render(<ErrorScreen error={err} retry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("lab_status failed");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /copy details/i }));
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Digest: abc123"));
  });

  it("keeps a crash inside the boundary and clears it on a new key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom({ explode }: { explode: boolean }): React.ReactNode {
      if (explode) throw new Error("step crashed");
      return <p>step ok</p>;
    }
    const { rerender } = render(
      <ErrorBoundary resetKey="a" title="This step failed">
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText("This step failed")).toBeTruthy();
    rerender(
      <ErrorBoundary resetKey="b" title="This step failed">
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("step ok")).toBeTruthy();
  });
});

describe("CommandPalette", () => {
  const make = () => {
    const ran: string[] = [];
    const cmds: Command[] = [
      { id: "labs", label: "Labs", icon: FlaskConical, group: "Screens", run: () => ran.push("labs") },
      { id: "servers", label: "Servers", hint: "Proxmox, ESXi", icon: Server, group: "Screens", run: () => ran.push("servers") },
      { id: "goad", label: "GOAD Light", keywords: "active directory", icon: FlaskConical, group: "Labs", run: () => ran.push("goad") },
    ];
    return { ran, cmds };
  };

  it("filters as you type and runs the selection with Enter", async () => {
    const { ran, cmds } = make();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open onClose={onClose} commands={cmds} />);
    const input = screen.getByRole("dialog").querySelector("input")!;
    await user.type(input, "directory");
    expect(screen.queryByText("Servers")).toBeNull();
    await user.keyboard("{Enter}");
    expect(ran).toEqual(["goad"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("moves with the arrow keys, closes with Escape and says when nothing matches", async () => {
    const { ran, cmds } = make();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open onClose={onClose} commands={cmds} />);
    const input = screen.getByRole("dialog").querySelector("input")!;
    input.focus();
    // Down twice, then up: the second row. Up twice from there wraps to the last.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
    expect(ran).toEqual(["servers"]);
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    expect(ran).toEqual(["servers", "goad"]);
    await user.type(input, "zzz");
    expect(screen.getByRole("dialog").textContent).toMatch(/no/i);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("runs a command on click and closes on the backdrop", async () => {
    const { ran, cmds } = make();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open onClose={onClose} commands={cmds} />);
    await user.click(screen.getByText("Servers"));
    expect(ran).toEqual(["servers"]);
    await user.click(document.querySelector<HTMLElement>("[aria-modal=true]")!.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing while closed", () => {
    render(<CommandPalette open={false} onClose={vi.fn()} commands={make().cmds} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  it("confirms or cancels", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog title="Remove the lab?" confirmLabel="Remove" onConfirm={onConfirm} onCancel={onCancel}>
        Its machines are deleted.
      </ConfirmDialog>,
    );
    expect(screen.getByText("Its machines are deleted.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    const cancel = screen.getAllByRole("button").find((b) => b.textContent !== "Remove");
    await user.click(cancel!);
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("PortModePrompt", () => {
  it("asks which ports, and remembers the answer when asked to", async () => {
    const user = userEvent.setup();
    render(<PortModePrompt />);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askPortMode("Invoice portal API");
    });
    expect(screen.getByText(/Invoice portal API/)).toBeTruthy();
    await user.click(screen.getByText("The lab's default ports"));
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: /start lab/i }));
    await expect(answer).resolves.toBe("default");
    expect(getPortMode()).toBe("default");
  });

  it("answers null on cancel, and cancels an earlier question on a new one", async () => {
    const user = userEvent.setup();
    render(<PortModePrompt />);
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = askPortMode("A");
    });
    act(() => {
      second = askPortMode("B");
    });
    await expect(first).resolves.toBeNull();
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await expect(second).resolves.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ServerSelfTest", () => {
  it("shows each step as the host reports it, and the result", async () => {
    installTauri({
      server_selftest: (a) => {
        stream(
          a,
          { step: "connect", label: "Connect", state: "ok", detail: null },
          { step: "prepare", label: "Prepare", state: "ok", detail: "template ready" },
          { step: "apply", label: "Create", state: "fail", detail: "no space left on datastore" },
        );
        return null;
      },
    });
    const onDone = vi.fn();
    render(<ServerSelfTest id="pve" provider="proxmox" onDone={onDone} />);
    await flush(30);
    expect(onDone).toHaveBeenCalledWith("fail");
    expect(screen.getByText(/no space left on datastore/)).toBeTruthy();
  });

  it("passes on ESXi when every step passes", async () => {
    installTauri({
      server_selftest: (a) => {
        stream(a, { step: "connect", label: "Connect", state: "ok", detail: null });
        return null;
      },
    });
    const onDone = vi.fn();
    render(<ServerSelfTest id="esxi" provider="vmware_esxi" onDone={onDone} />);
    await flush(30);
    expect(onDone).toHaveBeenCalledWith("ok");
  });

  it("fails when the command errors", async () => {
    const calls = installTauri({
      server_selftest: () => {
        throw new Error("host unreachable");
      },
    });
    const onDone = vi.fn();
    render(<ServerSelfTest id="pve" provider="proxmox" onDone={onDone} />);
    await flush(30);
    expect(onDone).toHaveBeenCalledWith("fail");
    expect(screen.getByText(/host unreachable/)).toBeTruthy();
    expect(commands(calls)).toContain("server_selftest");
  });
});
