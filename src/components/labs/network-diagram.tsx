"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import { Box, Check, Copy, Database, DoorOpen, Globe2, Laptop, Lock, Monitor, Network, Plug, Server, ShieldCheck, Terminal, Workflow, Zap, type LucideIcon } from "lucide-react";
import type { LabInterface, LabMachine, LabNetwork } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// A network diagram for the lab, laid out by ELK (layered, orthogonal links). Each Docker
// network is a zone (area) with its bridge (switch) in it; machines on one network sit in
// its zone and plug into the bridge. A machine on several networks (a pivot) sits between
// the zones it bridges, ordered by how far each network is from the attacker. The attack
// box is plugged into the lab network it joined, like any machine (one attack box can be
// attached to several running labs). Each
// machine shows its open ports as "doors". Addresses are click-to-copy.

type Port = { published: number; target: number };
type Machine = LabMachine;
type Attacker = { running: boolean; ip: string; labNetwork?: string } | null;

const violet = "#a78bfa"; // web/api service accent
const attack = "#f0616d"; // red: the attacker and its pivot into the lab network

function isIp(s: string) {
  return /^\d{1,3}\.\d{1,3}\./.test(s);
}

/** Docker lists a published port once per address family (0.0.0.0 and ::): keep one. */
function uniquePorts(ports: Port[]) {
  return ports.filter((p, i) => ports.findIndex((q) => q.published === p.published && q.target === p.target) === i);
}

/** Compose's implicit network is "default"; to a player it's just the lab network. */
function netLabel(name: string) {
  return name === "default" ? "lab" : name;
}

/** Click-to-copy wrapper (addresses). Stops React Flow from dragging the node. */
function CopyText({ text, children }: { text: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className="copy-chip"
      title={`Copy ${text}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          })
          .catch(() => {});
      }}
    >
      {children}
      {copied ? <Check size={11} className="copy-ok" /> : <Copy size={11} className="copy-ico" />}
    </span>
  );
}

function PortHandles({ accent = "#6b7280", sides = false }: { accent?: string; sides?: boolean }) {
  const style = { "--handle-accent": accent } as React.CSSProperties;
  return (
    <>
      <Handle type="target" position={Position.Top} className="topology-handle" style={style} />
      <Handle type="source" position={Position.Bottom} className="topology-handle" style={style} />
      {/* A pivot links to whole network segments, left (nearer) and right (deeper). */}
      {sides && <Handle id="w" type="target" position={Position.Left} className="topology-handle" style={style} />}
      {sides && <Handle id="e" type="source" position={Position.Right} className="topology-handle" style={style} />}
    </>
  );
}

/** A localhost port-binding: a small node on the host-card edge, linked to its container. */
function HostPortNode({ data }: NodeProps<Node<{ addr: string }>>) {
  return (
    <div className="hostport">
      <Handle type="target" position={Position.Top} className="topology-handle" style={{ "--handle-accent": "#54c171" } as React.CSSProperties} />
      <Plug size={11} />
      <span className="mono">{data.addr}</span>
    </div>
  );
}

/** A dashed network segment (area) that frames the nodes inside it. */
function ZoneNode({ data }: NodeProps<Node<{ label: string; tone?: "attack"; isolated?: boolean }>>) {
  return (
    <div className={`zone ${data.tone === "attack" ? "zone-attack" : ""}`}>
      {/* The segment's own ports: pivots plug into the network here. */}
      <Handle id="w" type="target" position={Position.Left} className="topology-handle zone-handle" />
      <Handle id="e" type="source" position={Position.Right} className="topology-handle zone-handle" />
      <span className="zone-label">
        {data.label}
        {data.isolated && (
          <span className="zone-isolated">
            <Lock size={9} /> no internet
          </span>
        )}
      </span>
    </div>
  );
}

/** A network bridge (the Docker bridge = a switch). Machines plug into it. */
function BridgeNode({ data }: NodeProps<Node<{ label: string; tone?: "attack" }>>) {
  return (
    <div className={`bridge ${data.tone === "attack" ? "bridge-attack" : ""}`}>
      <PortHandles accent={data.tone === "attack" ? attack : "#6b7280"} />
      <Network size={16} />
      <span className="bridge-label">{data.label}</span>
    </div>
  );
}

function AttackerNode({ data }: NodeProps<Node<{ label: string; subtitle: string; running: boolean }>>) {
  return (
    <div className="topology-node attacker-node">
      <PortHandles accent={attack} />
      <div className="attacker-glow" />
      <div className="attacker-icon">
        <Terminal size={18} />
      </div>
      <div className="node-copy">
        <div className="attacker-kicker">
          <span className="you-chip">YOU</span> ATTACKER
        </div>
        <div className="node-title">{data.label}</div>
        <div className="node-subtitle" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: data.running ? "#54c171" : "#6b6b6b" }} />
          {data.running && isIp(data.subtitle) ? <CopyText text={data.subtitle}>{data.subtitle}</CopyText> : data.subtitle}
        </div>
      </div>
      <ShieldCheck className="attacker-shield" size={17} />
    </div>
  );
}

type ServiceType = "database" | "web" | "cache" | "worker" | "service";
type ComputerData = { hostname: string; image: string; type: ServiceType; ifaces: LabInterface[]; running: boolean; ports: Port[] };

const serviceMeta: Record<ServiceType, { icon: LucideIcon; label: string; color: string }> = {
  database: { icon: Database, label: "database", color: "#56b6e6" },
  web: { icon: Globe2, label: "web / api", color: violet },
  cache: { icon: Zap, label: "cache", color: "#f5b544" },
  worker: { icon: Workflow, label: "worker", color: "#a3a3a3" },
  service: { icon: Box, label: "service", color: "#a3a3a3" },
};

function serviceType(image: string, name: string): ServiceType {
  const s = `${image} ${name}`.toLowerCase();
  if (/(maria|mysql|postgres|psql|mongo|sqlite|mssql|cassandra|database|[-_]db\b|^db)/.test(s)) return "database";
  if (/(redis|memcache|cache|valkey)/.test(s)) return "cache";
  if (/(nginx|caddy|apache|httpd|web|api|frontend|portal|gateway|proxy|node|php|python|flask|django|rails)/.test(s)) return "web";
  if (/(worker|queue|rabbit|kafka|job|cron|evidence|seed|init|place|curl)/.test(s)) return "worker";
  return "service";
}

function ComputerNode({ data }: NodeProps<Node<ComputerData>>) {
  const meta = serviceMeta[data.type];
  const ServiceIcon = meta.icon;
  const ip = data.ifaces[0]?.ip ?? "";
  const pivot = data.ifaces.length > 1;
  return (
    <div className="topology-node computer-node">
      <PortHandles accent={meta.color} sides={pivot} />
      <div className="computer-header">
        <div className="computer-name">
          <Monitor size={15} />
          <span className="mono">{data.hostname}</span>
        </div>
        <span className="running">
          <i /> {data.running ? "running" : "stopped"}
        </span>
      </div>
      {pivot ? (
        // One row per network: a pivot is reachable at a different address on each.
        <div className="ifaces">
          {data.ifaces.map((i) => (
            <div key={i.network} className="iface">
              <span className="iface-net">{netLabel(i.network)}</span>
              <span className="mono">{isIp(i.ip) ? <CopyText text={i.ip}>{i.ip}</CopyText> : i.ip}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="computer-ip mono">{isIp(ip) ? <CopyText text={ip}>{ip}</CopyText> : ip || "resolving…"}</div>
      )}
      <div className="service-chip" style={{ "--service-color": meta.color } as React.CSSProperties}>
        <div className="service-icon">
          <ServiceIcon size={15} />
        </div>
        <div className="service-main">
          <span>{data.image}</span>
          <small>{meta.label}</small>
        </div>
      </div>
      {/* service ports = doors into the machine */}
      <div className="doors">
        {data.ports.length === 0 ? (
          <span className="door-none">no open ports</span>
        ) : (
          data.ports.map((p, i) => {
            // The port the service listens on inside the container. Publishing to the host is
            // shown once, by the 127.0.0.1 node below, not here too.
            const bind = p.target || p.published;
            return (
              <CopyText key={i} text={`${ip}:${bind}`}>
                <span className="door">
                  <DoorOpen size={12} />
                  <span className="mono">:{bind}</span>
                </span>
              </CopyText>
            );
          })
        )}
      </div>
    </div>
  );
}

type Pt = { x: number; y: number };

/** An orthogonal polyline with rounded corners (the network-diagram look). */
function roundedPath(pts: Pt[], r = 8) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const rad = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const into = { x: b.x - Math.sign(b.x - a.x) * rad, y: b.y - Math.sign(b.y - a.y) * rad };
    const out = { x: b.x + Math.sign(c.x - b.x) * rad, y: b.y + Math.sign(c.y - b.y) * rad };
    d += ` L ${into.x} ${into.y} Q ${b.x} ${b.y} ${out.x} ${out.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

/** Midpoint of the longest segment: where a label sits without hiding a corner. */
function labelPoint(pts: Pt[]): Pt {
  let best = { len: -1, at: pts[0] };
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (len > best.len) best = { len, at: { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 } };
  }
  return best.at;
}

type LinkData = { label?: string; route?: Pt[] };

/** Draws ELK's route. If a node was dragged away from it, falls back to a smooth step. */
function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data }: EdgeProps<Edge<LinkData>>) {
  const route = data?.route;
  // ELK ends on the border; the handle dot straddles it, a few px off along the link.
  const near = (a: Pt, x: number, y: number) => Math.abs(a.x - x) < 10 && Math.abs(a.y - y) < 10;
  let path: string;
  let at: Pt;
  if (route && route.length >= 2 && near(route[0], sourceX, sourceY) && near(route[route.length - 1], targetX, targetY)) {
    // Snap the ends onto the handles.
    const pts = [{ x: sourceX, y: sourceY }, ...route.slice(1, -1), { x: targetX, y: targetY }];
    path = roundedPath(pts);
    at = labelPoint(pts);
  } else {
    const [p, x, y] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
    path = p;
    at = { x, y };
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${at.x}px,${at.y}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { zone: ZoneNode, bridge: BridgeNode, attacker: AttackerNode, computer: ComputerNode, hostport: HostPortNode };
const edgeTypes = { link: LinkEdge };

const GREY = "#4f4f4f";
const GREEN = "#54c171";
const PIVOT = "#8b7cc4"; // a pivot's link on into a deeper network
function link(id: string, source: string, target: string, color: string, opts: { animated?: boolean; dashed?: boolean; label?: string; sideways?: boolean } = {}): Edge<LinkData> {
  return {
    id,
    source,
    target,
    // Sideways = segment to pivot to segment, through the left/right handles.
    ...(opts.sideways ? { sourceHandle: "e", targetHandle: "w" } : {}),
    type: "link",
    animated: opts.animated,
    data: { label: opts.label },
    style: { stroke: color, strokeWidth: 1.8, strokeDasharray: opts.animated || opts.dashed ? "5 5" : undefined, opacity: color === GREY ? 0.8 : 1 },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
  };
}

const BRIDGE = { w: 136, h: 60 };
const HOSTPORT_W = 128;

/** The lab as a graph: zones (networks) holding bridges and single-homed machines, pivots
 *  between zones, the attack zone on top and localhost bindings below. Positions come later. */
type Topology = { nodes: Node[]; edges: Edge<LinkData>[]; zones: { id: string; members: string[]; data: Record<string, unknown> }[] };

function topology(machines: Machine[], networks: LabNetwork[], attacker: Attacker): Topology {
  const atkOn = !!attacker?.running;

  // Networks: as reported, plus any a machine names that wasn't (best effort), or a single
  // synthetic one for runtimes that report no networks (its subnet guessed from an address).
  const nets = new Map<string, LabNetwork>(networks.map((n) => [n.name, n]));
  const ifacesOf = (m: Machine): LabInterface[] => {
    if (m.interfaces?.length) return m.interfaces;
    const fallback = nets.keys().next().value ?? "default";
    return [{ network: fallback, ip: m.ip }];
  };
  machines.forEach((m) => ifacesOf(m).forEach((i) => nets.has(i.network) || nets.set(i.network, { name: i.network, subnet: "", internal: false })));
  if (nets.size === 0) nets.set("default", { name: "default", subnet: "", internal: false });
  for (const n of nets.values()) {
    if (!n.subnet) {
      const ip = machines.flatMap(ifacesOf).find((i) => i.network === n.name && isIp(i.ip))?.ip;
      if (ip) n.subnet = `${ip.split(".").slice(0, 2).join(".")}.0.0/16`;
    }
  }

  // Distance of each network from where the attacker enters, hopping through pivots, so the
  // tree reads top-down in attack order: attack box → entry network → pivot → deeper network.
  const entry = (attacker?.labNetwork && nets.has(attacker.labNetwork) && attacker.labNetwork) || (nets.has("default") ? "default" : [...nets.keys()][0]);
  const dist = new Map<string, number>([[entry, 0]]);
  for (let frontier = [entry]; frontier.length; ) {
    const next: string[] = [];
    for (const net of frontier) {
      for (const m of machines) {
        const on = ifacesOf(m).map((i) => i.network);
        if (!on.includes(net)) continue;
        for (const other of on.filter((o) => !dist.has(o))) {
          dist.set(other, dist.get(net)! + 1);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const d = (net: string) => dist.get(net) ?? 99;

  const nodes: Node[] = [];
  const edges: Edge<LinkData>[] = [];
  const zones: Topology["zones"] = [];

  // One zone per lab network, nearest first.
  const ordered = [...nets.values()].sort((a, b) => d(a.name) - d(b.name) || a.name.localeCompare(b.name));
  const members = new Map<string, string[]>(ordered.map((n) => [n.name, [`bridge-${n.name}`]]));
  ordered.forEach((n) =>
    nodes.push({ id: `bridge-${n.name}`, type: "bridge", position: { x: 0, y: 0 }, style: { width: BRIDGE.w, height: BRIDGE.h }, data: { label: `${netLabel(n.name)} bridge` }, draggable: false }),
  );

  // The attack box is a host on the lab network like the others (one attack box can be
  // attached to several running labs at once), first in its zone so it reads leftmost.
  // No attack box at all (VM labs) draws none.
  if (attacker) {
    nodes.push({ id: "__attacker", type: "attacker", position: { x: 0, y: 0 }, data: { label: "Attack box", subtitle: atkOn ? attacker.ip || "attached" : "not attached", running: atkOn } });
    members.get(entry)!.push("__attacker");
    edges.push(link("e-attach", `bridge-${entry}`, "__attacker", atkOn ? attack : "#5a5a5a", { animated: atkOn }));
  }

  machines.forEach((m) => {
    const ifaces = ifacesOf(m);
    const type = serviceType(m.image, m.name);
    const id = `svc-${m.name}`;
    nodes.push({
      id,
      type: "computer",
      position: { x: 0, y: 0 },
      data: { hostname: m.name, image: m.image || serviceMeta[type].label, type, ifaces, running: m.state === "running", ports: uniquePorts(m.ports) } satisfies ComputerData,
    });
    if (ifaces.length === 1) {
      members.get(ifaces[0].network)!.push(id);
      edges.push(link(`e-${ifaces[0].network}-${m.name}`, `bridge-${ifaces[0].network}`, id, GREY));
    } else {
      // A pivot plugs into its nearest network(s) and leads on into the deeper ones; each
      // link carries its address on that network.
      const near = Math.min(...ifaces.map((i) => d(i.network)));
      ifaces.forEach((i) =>
        edges.push(
          d(i.network) === near
            ? link(`e-${i.network}-${m.name}`, `zone-${i.network}`, id, GREY, { sideways: true, label: i.ip })
            : link(`e-${m.name}-${i.network}`, id, `zone-${i.network}`, PIVOT, { sideways: true, label: i.ip }),
        ),
      );
    }
    // Localhost port bindings: a small node below, linked from the container it forwards to.
    uniquePorts(m.ports)
      .filter((p) => p.published > 0)
      .forEach((p) => {
        const hp = `hp-${m.name}-${p.published}`;
        nodes.push({ id: hp, type: "hostport", position: { x: 0, y: 0 }, style: { width: HOSTPORT_W }, data: { addr: `127.0.0.1:${p.published}` }, draggable: false, selectable: false });
        edges.push(link(`e-${hp}`, id, hp, GREEN, { dashed: true, label: "published" }));
      });
  });

  ordered.forEach((n) => {
    const ids = members.get(n.name)!;
    const hosts = machines.filter((m) => ifacesOf(m).some((i) => i.network === n.name));
    const exposed = hosts.filter((m) => m.ports.some((p) => p.published > 0)).length;
    const label = [`${netLabel(n.name).toUpperCase()} NETWORK`, n.subnet, `${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`, exposed ? `${exposed} exposed` : ""].filter(Boolean).join(" · ");
    zones.push({ id: `zone-${n.name}`, members: ids, data: { label, isolated: n.internal } });
  });

  return { nodes, edges, zones };
}

const elk = new ELK();

/** Lays the measured nodes out with ELK. Zones run left to right in attack order (attack →
 *  entry network → pivot → deeper network); inside a zone the bridge sits above its machines.
 *  Localhost bindings are left out of ELK and set in a band along the bottom (the host edge).
 *  Returns absolute positions, zone frames and routes. */
async function layout(topo: Topology, size: (id: string) => { w: number; h: number }) {
  const inZone = new Set(topo.zones.flatMap((z) => z.members));
  const isHostPort = (id: string) => id.startsWith("hp-");
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
          "elk.padding": "[top=36,left=20,bottom=20,right=20]",
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
      .filter((e) => !isHostPort(e.target))
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

  // The host edge: each binding under its container, side by side when it has several.
  let height = out.height ?? 0;
  const bottom = Math.max(...[...boxes.values()].map((b) => b.y + b.h)) + 46;
  const byMachine = new Map<string, Edge<LinkData>[]>();
  topo.edges.filter((e) => isHostPort(e.target)).forEach((e) => byMachine.set(e.source, [...(byMachine.get(e.source) ?? []), e]));
  byMachine.forEach((list, machine) => {
    const m = boxes.get(machine);
    if (!m) return;
    list.forEach((e, k) => {
      const { w, h } = size(e.target);
      const x = m.x + m.w / 2 - w / 2 + (k - (list.length - 1) / 2) * (w + 14);
      boxes.set(e.target, { x, y: bottom, w, h });
      routes.set(e.id, [
        { x: m.x + m.w / 2, y: m.y + m.h },
        { x: m.x + m.w / 2, y: bottom - 20 },
        { x: x + w / 2, y: bottom - 20 },
        { x: x + w / 2, y: bottom },
      ]);
      height = Math.max(height, bottom + h + 24);
    });
  });
  const width = Math.max(out.width ?? 0, ...[...boxes.values()].map((b) => b.x + b.w + 24));
  return { boxes, routes, width, height };
}

const PAD = 0.06;

function Flow({ topo, onSize, fitKey }: { topo: Topology; onSize: (w: number, h: number) => void; fitKey: string }) {
  // First pass renders the nodes invisibly so React Flow measures them; then ELK lays them out
  // with their real sizes (a card grows with its interfaces and ports).
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(topo.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const measured = useNodesInitialized();
  const { getNode, fitView } = useReactFlow();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!measured || ready) return;
    let live = true;
    const size = (id: string) => {
      const n = getNode(id);
      return { w: n?.measured?.width ?? 200, h: n?.measured?.height ?? 120 };
    };
    layout(topo, size)
      .then(({ boxes, routes, width, height }) => {
        if (!live) return;
        const zones: Node[] = topo.zones.map((z) => {
          const b = boxes.get(z.id)!;
          return { id: z.id, type: "zone", position: { x: b.x, y: b.y }, style: { width: b.w, height: b.h }, data: z.data, draggable: false, selectable: false };
        });
        setNodes([...zones, ...topo.nodes.map((n) => ({ ...n, position: { x: boxes.get(n.id)?.x ?? 0, y: boxes.get(n.id)?.y ?? 0 } }))]);
        setEdges(topo.edges.map((e) => ({ ...e, data: { ...e.data, route: routes.get(e.id) } })));
        onSize(width, height);
        setReady(true);
      })
      .catch((e) => {
        console.warn("network diagram layout failed", e);
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [measured, ready, topo, getNode, setNodes, setEdges, onSize]);

  // Fit once laid out, and again whenever the shell changes size.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => fitView({ padding: PAD, maxZoom: 1.05 }), 30);
    return () => clearTimeout(t);
  }, [ready, fitView, fitKey]);

  return (
    <ReactFlow
      className={cn("transition-opacity duration-200", ready ? "opacity-100" : "opacity-0")}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      minZoom={0.25}
      maxZoom={1.5}
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#242424" />
    </ReactFlow>
  );
}

export function NetworkDiagram({ machines, networks = [], attacker = null, host = null }: { machines: Machine[]; networks?: LabNetwork[]; attacker?: Attacker; host?: string | null }) {
  // Re-layout only when the topology changes (not on every status poll).
  const sig =
    machines.map((m) => `${m.name}:${m.state}:${m.ip}:${(m.interfaces ?? []).map((i) => `${i.network}=${i.ip}`).join(",")}:${m.ports.map((p) => `${p.published}-${p.target}`).join(",")}`).join("|") +
    `#${networks.map((n) => `${n.name}=${n.subnet}${n.internal ? "!" : ""}`).join(",")}` +
    `#${attacker?.running ? `${attacker.ip}@${attacker.labNetwork ?? ""}` : "off"}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sig captures everything drawn
  const topo = useMemo(() => topology(machines, networks, attacker), [sig]);

  // Size the shell to the graph's shape at the current width: tall labs get room instead of
  // being shrunk to fit. Tracks the shell's width so a resized window re-fits.
  const shell = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<{ w: number; h: number } | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = shell.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onSize = useCallback((w: number, h: number) => setGraph({ w, h }), []);
  const scale = graph && width ? Math.min(1.05, (width * (1 - 2 * PAD)) / Math.max(graph.w, 1)) : 1;
  const height = graph ? Math.round(Math.min(720, Math.max(340, (graph.h * scale) / (1 - 2 * PAD)))) : 430;

  return (
    <div className="hostcard">
      <div className="hostcard-header">
        <span className="hostcard-icon">{host ? <Server size={16} /> : <Laptop size={16} />}</span>
        <div>
          <div className="hostcard-title">{host ?? "Your machine"}</div>
          <div className="hostcard-sub mono">{host ? "server · docker host" : "127.0.0.1 · host"}</div>
        </div>
        <span className="hostcard-online">
          <i /> online
        </span>
      </div>

      <div ref={shell} className="topology-shell" style={{ height }}>
        <ReactFlowProvider key={sig}>
          <Flow topo={topo} onSize={onSize} fitKey={`${width}x${height}`} />
        </ReactFlowProvider>
      </div>
      <div className="topology-legend topology-legend-bar">
        <div>
          <DoorOpen size={12} /> <span>service port</span>
        </div>
        <div>
          <Plug size={12} className="legend-exposed" /> <span>published to 127.0.0.1</span>
        </div>
        <div>
          <Copy size={11} /> <span>click to copy</span>
        </div>
      </div>
    </div>
  );
}
