"use client";

import { useEffect } from "react";

/** Esc returns to the list (unless a dialog or a field is focused, which handle Esc themselves). */
export function useEscapeBack(onBack: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest("[role=dialog],[role=alertdialog]"))) return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
}
