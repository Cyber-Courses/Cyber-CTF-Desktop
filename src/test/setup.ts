import { afterEach, vi } from "vitest";

// Shared setup for every test file. Node-environment tests skip the DOM half.
if (typeof window !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  const { clearMocks } = await import("@tauri-apps/api/mocks");

  // `ignore()` logs expected, harmless failures at debug level: keep the test output readable.
  vi.spyOn(console, "debug").mockImplementation(() => {});

  // jsdom lacks the layout APIs React Flow, xterm and the dialogs reach for.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  if (!window.matchMedia) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  }
  Element.prototype.scrollIntoView ??= () => {};
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };

  afterEach(() => {
    cleanup();
    clearMocks();
    try {
      localStorage.clear();
    } catch {
      /* no storage */
    }
  });
}
