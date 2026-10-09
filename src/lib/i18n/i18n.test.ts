import { describe, expect, it } from "vitest";

import en from "@/messages/en";
import fr from "@/messages/fr";

/** Every leaf path of a message tree ({ one, other } plurals count as one leaf). */
function leaves(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  const o = node as Record<string, unknown>;
  if (o && typeof o.one === "string" && typeof o.other === "string") return [prefix];
  return Object.entries(o ?? {}).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}|<(\w+)>/g)].map((m) => m[1] ?? m[2]).sort();
const at = (tree: unknown, path: string) => path.split(".").reduce<unknown>((n, p) => (n as Record<string, unknown>)?.[p], tree);
const texts = (v: unknown): string[] => (typeof v === "string" ? [v] : Object.values(v as Record<string, string>));

describe("messages", () => {
  it("French has every English message, and nothing English doesn't", () => {
    expect(leaves(fr).sort()).toEqual(leaves(en).sort());
  });

  it("French keeps the same placeholders and tags", () => {
    for (const path of leaves(en)) {
      const e = texts(at(en, path)).flatMap(placeholders);
      const f = texts(at(fr, path)).flatMap(placeholders);
      expect(new Set(f), path).toEqual(new Set(e));
    }
  });

  it("no em dashes (house style)", () => {
    for (const tree of [en, fr]) for (const path of leaves(tree)) for (const s of texts(at(tree, path))) expect(s.includes("—"), path).toBe(false);
  });
});
