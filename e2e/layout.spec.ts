import { test, expect, openApp, navButton, pageTitle, horizontalOverflow } from "./fixtures";

// At 1280x800 (the config's viewport), no main screen scrolls sideways.
test.describe("layout", () => {
  test("main screens fit the width", async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
    await openApp(page);
    for (const [tab, heading] of [
      ["Overview", /Florian/],
      ["Labs", "Labs"],
      ["Machine", "Machine"],
      ["Servers", "Servers"],
      ["Cloud", "Cloud"],
    ] as const) {
      await navButton(page, tab).click();
      await expect(pageTitle(page)).toHaveText(heading);
      expect(await horizontalOverflow(page), `${tab} overflows`).toEqual([]);
    }

    // A running lab's page, with its network diagram.
    await navButton(page, "Labs").click();
    await page.locator("main").getByRole("button", { name: "Open Invoice portal API", exact: true }).click();
    await expect(page.locator(".react-flow")).toBeVisible();
    expect(await horizontalOverflow(page), "lab page overflows").toEqual([]);
  });

  test("Settings fits the width", async ({ page }) => {
    await page.goto("/?mock&window=settings");
    const sections = page.getByRole("navigation", { name: "Settings sections" });
    for (const section of ["Account", "Appearance", "Labs", "Maintenance", "About"]) {
      await sections.getByRole("button", { name: section }).click();
      await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
      expect(await horizontalOverflow(page), `${section} overflows`).toEqual([]);
    }
  });
});
