import { describe, expect, it } from "vitest";

import { PORT_TAB_SLOT, layout } from "@/features/labs/network-diagram/layout";
import { topology } from "@/features/labs/network-diagram/topology";
import type { Machine, Pt } from "@/features/labs/network-diagram/model";

const machine = (name: string, ip: string, published: number[]): Machine => ({
  name,
  state: "running",
  image: `${name}:latest`,
  ip,
  ports: published.map((p, i) => ({ published: p, target: 80 + i })),
  interfaces: [{ network: "default", ip }],
  services: [],
  infra: false,
});

describe("published port tabs", () => {
  it("never overlap, under one machine or across neighbours", async () => {
    // CI/CD Goat-like: several machines side by side, each publishing several ports.
    const machines = [
      machine("jenkins", "10.0.0.2", [51198, 51199, 51200]),
      machine("gitea", "10.0.0.3", [51201, 51202]),
      machine("ctfd", "10.0.0.4", [51203]),
    ];
    const topo = topology(machines, [{ name: "default", subnet: "10.0.0.0/24", internal: false }], null);
    const { boxes } = await layout(topo, (id) => (id.startsWith("hp-") ? { w: 2, h: 2 } : { w: 220, h: 140 }));
    const centres = [...boxes.entries()]
      .filter(([id]) => id.startsWith("hp-"))
      .map(([, b]) => b.x + b.w / 2)
      .sort((a, b) => a - b);
    expect(centres).toHaveLength(6);
    centres.slice(1).forEach((c, i) => expect(c - centres[i]).toBeGreaterThanOrEqual(PORT_TAB_SLOT));
  });
});

type Seg = [Pt, Pt];
const segments = (r: Pt[]): Seg[] => r.slice(1).map((p, i) => [r[i], p]);
// Orthogonal segments cross when one is vertical, the other horizontal, and each spans the other.
const cross = ([a, b]: Seg, [c, d]: Seg) => {
  const v1 = a.x === b.x,
    v2 = c.x === d.x;
  if (v1 === v2) return false;
  const [v, h] = v1
    ? [
        [a, b],
        [c, d],
      ]
    : [
        [c, d],
        [a, b],
      ];
  const within = (x: number, p: number, q: number) => x > Math.min(p, q) && x < Math.max(p, q);
  return within(v[0].x, h[0].x, h[1].x) && within(h[0].y, v[0].y, v[1].y);
};

describe("published port links", () => {
  it("leave from their service's box and don't cross", async () => {
    const m: Machine = {
      ...machine("web", "10.0.0.2", []),
      ports: [
        { published: 8080, target: 80 },
        { published: 3307, target: 3306 },
      ],
      services: [
        { name: "portal", kind: "http", ports: [80] },
        { name: "db", kind: "mysql", ports: [3306] },
      ],
    };
    const topo = topology([m], [{ name: "default", subnet: "10.0.0.0/24", internal: false }], null);
    // The portal row sits above the db row; each handle on its box's right edge.
    const handles: Record<string, Pt> = { "pub-8080": { x: 220, y: 70 }, "pub-3307": { x: 220, y: 115 } };
    const { boxes, routes } = await layout(
      topo,
      (id) => (id.startsWith("hp-") ? { w: 2, h: 2 } : { w: 220, h: 140 }),
      (_node, handle) => handles[handle],
    );
    const web = [...boxes.entries()].find(
      ([id]) => !id.startsWith("hp-") && !id.startsWith("zone") && !id.startsWith("bridge") && boxes.get(id)!.h === 140,
    )![1];
    const portal = routes.get("e-hp-web-8080")!;
    const db = routes.get("e-hp-web-3307")!;
    expect(portal[0]).toEqual({ x: web.x + 220, y: web.y + 70 });
    expect(db[0]).toEqual({ x: web.x + 220, y: web.y + 115 });
    for (const s1 of segments(portal)) for (const s2 of segments(db)) expect(cross(s1, s2)).toBe(false);
  });
});
