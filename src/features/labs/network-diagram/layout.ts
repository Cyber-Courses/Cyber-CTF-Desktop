import { type Edge } from "@xyflow/react";
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import { LinkData, Pt } from "@/features/labs/network-diagram/model";
import { Topology } from "@/features/labs/network-diagram/topology";

// ELK layout of the topology; published ports are placed after it, along the card's bottom edge.

const elk = new ELK();

/** Lays the measured nodes out with ELK. Zones run left to right in attack order (attack →
 *  entry network → pivot → deeper network); inside a zone the bridge sits above its machines.
 *  Localhost bindings are left out of ELK and set in a band along the bottom (the host edge).
 *  Returns absolute positions, zone frames and routes. */
export async function layout(topo: Topology, size: (id: string) => { w: number; h: number }) {
  const inZone = new Set(topo.zones.flatMap((z) => z.members));
  // Published ports and uplinks are placed after ELK, around the laid-out lab.
  const isHostPort = (id: string) => id.startsWith("hp-") || id.startsWith("up-");
  // Every node gets two fixed ports, top-centre in and bottom-centre out, matching the
  // React Flow handles, so ELK's routes end exactly on the dots.
  // Pivots (top-level machines) also get mid-height side ports, west in and east out.
  const leaf = (id: string, sides = false): ElkNode => {
    const { w, h } = size(id);
    return {
      id,
      width: w,
      height: h,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: [
        { id: `${id}:in`, x: w / 2, y: 0, width: 0, height: 0, layoutOptions: { "elk.port.side": "NORTH" } },
        { id: `${id}:out`, x: w / 2, y: h, width: 0, height: 0, layoutOptions: { "elk.port.side": "SOUTH" } },
        ...(sides
          ? [
              { id: `${id}:w`, x: 0, y: h / 2, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } },
              { id: `${id}:e`, x: w, y: h / 2, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } },
            ]
          : []),
      ],
    };
  };
  // ELK port for an edge end: a side handle ("w"/"e") or the default top/bottom one.
  const port = (node: string, handle: string | null | undefined, fallback: "in" | "out") => `${node}:${handle ?? fallback}`;
  const spacing = {
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.spacing.edgeNodeBetweenLayers": "20",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
    "elk.spacing.edgeNode": "18",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  };
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      ...spacing,
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "SEPARATE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.spacing.nodeNode": "40",
      "elk.padding": "[top=28,left=24,bottom=24,right=24]",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
    },
    children: [
      ...topo.zones.map((z) => ({
        id: z.id,
        layoutOptions: {
          ...spacing,
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.layered.spacing.nodeNodeBetweenLayers": "40",
          "elk.spacing.nodeNode": "24",
          "elk.padding": "[top=20,left=20,bottom=20,right=20]",
          "elk.portConstraints": "FIXED_SIDE",
        },
        children: z.members.map((id) => leaf(id)),
        // A segment's side ports: ELK centres a lone port on its side, matching the handles.
        ports: [
          { id: `${z.id}:w`, layoutOptions: { "elk.port.side": "WEST" } },
          { id: `${z.id}:e`, layoutOptions: { "elk.port.side": "EAST" } },
        ],
      })),
      ...topo.nodes.filter((n) => !inZone.has(n.id) && !isHostPort(n.id)).map((n) => leaf(n.id, true)),
    ],
    edges: topo.edges
      .filter((e) => !isHostPort(e.target) && !isHostPort(e.source))
      .map((e) => ({ id: e.id, sources: [port(e.source, e.sourceHandle, "out")], targets: [port(e.target, e.targetHandle, "in")] })),
  };
  const out = await elk.layout(graph);

  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (n: ElkNode) => {
    if (n.id !== "root") boxes.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? 0, h: n.height ?? 0 });
    n.children?.forEach(walk);
  };
  walk(out);
  const routes = new Map<string, Pt[]>();
  const collect = (n: ElkNode) => {
    (n.edges as ElkExtendedEdge[] | undefined)?.forEach((e) => {
      const s = e.sections?.[0];
      if (s) routes.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
    });
    n.children?.forEach(collect);
  };
  collect(out);

  // Published ports: a row below everything, each under its container (side by side when
  // it has several), linked up to it. The view docks this row on the card's bottom edge.
  const laid = [...boxes.values()];
  const minX = Math.min(...laid.map((b) => b.x));
  const minY = Math.min(...laid.map((b) => b.y));
  let maxX = Math.max(...laid.map((b) => b.x + b.w));
  let maxY = Math.max(...laid.map((b) => b.y + b.h));
  const rowY = maxY + 54;
  let docked = false;
  const byMachine = new Map<string, Edge<LinkData>[]>();
  topo.edges.filter((e) => isHostPort(e.target)).forEach((e) => byMachine.set(e.source, [...(byMachine.get(e.source) ?? []), e]));
  byMachine.forEach((list, machine) => {
    const m = boxes.get(machine);
    if (!m) return;
    list.forEach((e, k) => {
      const { w, h } = size(e.target);
      const x = m.x + m.w / 2 - w / 2 + (k - (list.length - 1) / 2) * (w + 14);
      boxes.set(e.target, { x, y: rowY, w, h });
      routes.set(e.id, [
        { x: m.x + m.w / 2, y: m.y + m.h },
        { x: m.x + m.w / 2, y: rowY - 24 },
        { x: x + w / 2, y: rowY - 24 },
        { x: x + w / 2, y: rowY },
      ]);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, rowY + h);
      docked = true;
    });
  });
  const bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY, docked };
  const width = bounds.w + 48;
  const height = bounds.h + 48;
  return { boxes, routes, width, height, bounds };
}
