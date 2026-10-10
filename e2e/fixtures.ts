import { test as base, expect, type Page } from "@playwright/test";

/** The six languages the launcher ships (src/lib/i18n). */
export const LOCALES = ["en", "fr", "es", "de", "pt-BR", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

/** What a missing translation renders: the key itself, like "labs.list.search". */
export const RAW_KEY = /^[a-z]+(\.[a-zA-Z]+)+$/;

type Fixtures = {
  /** The language every page of the test starts in (localStorage `cyberctf.locale`). */
  appLocale: Locale;
  /** Console errors, uncaught exceptions and missing-translation warnings, on every page of the
   *  test; the test fails if any were seen. */
  consoleErrors: string[];
};

export const test = base.extend<Fixtures>({
  appLocale: ["en", { option: true }],
  consoleErrors: [
    async ({ context, appLocale }, use) => {
      const errors: string[] = [];
      // Seeded before any app script runs, on every page (Settings and the server setup open in
      // new tabs): the language, and onboarding done so the shell shows.
      await context.addInitScript((locale) => {
        try {
          localStorage.setItem("cyberctf.locale", locale);
          localStorage.setItem("cyberctf.onboarded", "1");
        } catch {
          /* storage unavailable */
        }
      }, appLocale);
      const watch = (page: Page) => {
        page.on("console", (m) => {
          const text = m.text();
          if (m.type() === "error" || (m.type() === "warning" && text.startsWith("i18n: missing message"))) errors.push(`${page.url()}: ${text}`);
        });
        page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
      };
      context.pages().forEach(watch);
      context.on("page", watch);
      await use(errors);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Opens the main window with the mock and waits for the shell. */
export async function openApp(page: Page) {
  await page.goto("/?mock");
  await expect(page.locator("aside nav")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** A sidebar entry by its label (its name may go on with a count or a shortcut). */
export const navButton = (page: Page, name: string) =>
  page.locator("aside nav").getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });

/** The open screen's title. */
export const pageTitle = (page: Page) => page.locator("main").getByRole("heading", { level: 1 });

/** The header breadcrumb's last crumb (the open screen, or the open lab). */
export const breadcrumb = (page: Page) => page.locator("main > [data-tauri-drag-region] b");

/** Visible texts (and placeholders, labels) on the page that look like a raw message key. */
export function rawKeys(page: Page): Promise<string[]> {
  return page.evaluate((source) => {
    const re = new RegExp(source);
    const found = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim() ?? "";
      const el = n.parentElement;
      if (text && re.test(text) && el && el.checkVisibility()) found.add(text);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[placeholder], [aria-label], [title]")) {
      for (const attr of ["placeholder", "aria-label", "title"]) {
        const v = el.getAttribute(attr)?.trim();
        if (v && re.test(v)) found.add(`${attr}=${v}`);
      }
    }
    return [...found];
  }, RAW_KEY.source);
}

/** Whether the page or its main scroll area scrolls sideways: [scrollWidth, clientWidth] pairs. */
export function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const boxes = [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>("main .overflow-y-auto")];
    return boxes.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => `${b.tagName.toLowerCase()}.${b.className}: ${b.scrollWidth} > ${b.clientWidth}`);
  });
}
