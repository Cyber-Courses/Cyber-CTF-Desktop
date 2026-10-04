import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useEffect, useState } from "react";

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
 * The lab a `cyberctf://labs/<slug>` link asked for: the link that opened the
 * app, then any link opened while it runs. The lab is only shown, never
 * started: a web page must not be able to start containers without a click.
 */
export function useRequestedLab(): string | null {
  const [slug, setSlug] = useState<string | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const take = (urls: string[] | null) => {
      const found = urls?.map(labSlugFrom).find((s): s is string => s !== null);
      if (found) setSlug(found);
    };
    getCurrent()
      .then(take)
      .catch(() => {});
    onOpenUrl(take)
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, []);
  return slug;
}
