import { describe, expect, it } from "vitest";

import { layout } from "@/features/labs/network-diagram/layout";
import { topology } from "@/features/labs/network-diagram/topology";
import type { Machine } from "@/features/labs/network-diagram/model";

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
    const machines = [machine("jenkins", "10.0.0.2", [51198, 51199, 51200]), machine("gitea", "10.0.0.3", [51201, 51202]), machine("ctfd", "10.0.0.4", [51203])];
    const topo = topology(machines, [{ name: "default", subnet: "10.0.0.0/24", internal: false }], null);
    const { boxes } = await layout(topo, (id) => (id.startsWith("hp-") ? { w: 2, h: 2 } : { w: 220, h: 140 }));
    const centres = [...boxes.entries()]
      .filter(([id]) => id.startsWith("hp-"))
      .map(([, b]) => b.x + b.w / 2)
      .sort((a, b) => a - b);
    expect(centres).toHaveLength(6);
    centres.slice(1).forEach((c, i) => expect(c - centres[i]).toBeGreaterThanOrEqual(96));
  });
});
