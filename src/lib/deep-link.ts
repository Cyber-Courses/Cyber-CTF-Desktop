import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useEffect, useRef } from "react";
import { warn } from "@/lib/failure";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The lab slug in a `cyberctf://labs/<slug>` link, or null for anything else. */
export function labSlugFrom(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "cyberctf:" || u.hostname !== "labs") return null;
    const slug = u.pathname.replace(/^\/+|\/+$/g, "");
    return SLUG.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

/**
 * Calls `onLab` with the lab a `cyberctf://labs/<slug>` link asks for: the link that opened the
 * app, then every link opened while it runs (the same lab twice included). Used once, by the app
 * shell, so a link is heard whatever screen is showing. The lab is only shown, never started: a
 * web page must not be able to start containers without a click.
 */
export function useRequestedLab(onLab: (slug: string) => void) {
  const latest = useRef(onLab);
  useEffect(() => {
    latest.current = onLab;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const take = (urls: string[] | null) => {
      const found = urls?.map(labSlugFrom).find((s): s is string => s !== null);
      if (found) latest.current(found);
    };
    getCurrent().then(take).catch(warn("reading the link the app was opened with"));
    onOpenUrl(take)
      .then((fn) => (unlisten = fn))
      .catch(warn("listening for deep links"));
    return () => unlisten?.();
  }, []);
}
