// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell";
import { installTauri } from "@/test/tauri";

describe("AppShell", () => {
  it("renders the shell and walks every screen", async () => {
    localStorage.setItem("cyberctf.onboarded", "1");
    installTauri();
    const user = userEvent.setup();
    render(<AppShell />);
    const nav = await screen.findByRole("navigation");
    for (const name of ["Labs", "Events", "Machine", "Servers", "Cloud", "Overview"]) {
      await user.click(within(nav).getAllByRole("button", { name: new RegExp(name, "i") })[0]);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    expect(document.body.textContent).toBeTruthy();
  });
});
