"use client";

import { useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Box, Check, Copy, Database, DoorOpen, Globe2, Laptop, Monitor, Network, Plug, ShieldCheck, Terminal, Workflow, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// A network diagram for the lab: each Docker network is drawn as a zone (area) with its
// bridge (switch) in it; machines plug into the bridge. The attack box sits on its own
// attack network and is also wired into the lab bridge (dual-homed). Each machine shows
// its open ports as "doors". Addresses are click-to-copy.

type Port = { published: number; target: number };
type Machine = { name: string; state: string; image: string; ip: string; ports: Port[] };
type Attacker = { running: boolean; ip: string } | null;

const violet = "#a78bfa"; // web/api service accent
const attack = "#f0616d"; // red: the attacker and its pivot into the lab network

function isIp(s: string) {
  return /^\d{1,3}\.\d{1,3}\./.test(s);
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

function PortHandles({ accent = "#6b7280" }: { accent?: string }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className="topology-handle" style={{ "--handle-accent": accent } as React.CSSProperties} />
      <Handle type="source" position={Position.Bottom} className="topology-handle" style={{ "--handle-accent": accent } as React.CSSProperties} />
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
function ZoneNode({ data }: NodeProps<Node<{ label: string; tone?: "attack" }>>) {
  return (
    <div className={`zone ${data.tone === "attack" ? "zone-attack" : ""}`}>
      <span className="zone-label">{data.label}</span>
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
type ComputerData = { hostname: string; image: string; type: ServiceType; ip: string; running: boolean; ports: Port[] };

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
  const hasIp = isIp(data.ip);
  return (
    <div className="topology-node computer-node">
      <PortHandles accent={meta.color} />
      <div className="computer-header">
        <div className="computer-name">
          <Monitor size={15} />
          <span className="mono">{data.hostname}</span>
        </div>
        <span className="running">
          <i /> {data.running ? "running" : "stopped"}
        </span>
      </div>
      <div className="computer-ip mono">{hasIp ? <CopyText text={data.ip}>{data.ip}</CopyText> : data.ip}</div>
      <div className="service-chip" style={{ "--service-color": meta.color } as React.CSSProperties}>
        <div className="service-icon">
          <ServiceIcon size={15} />
        </div>
        <div className="service-main">
          <span>{data.image}</span>
          <small>{meta.label}</small>
        </div>
      </div>
      {/* open ports = doors into the machine */}
      <div className="doors">
        {data.ports.length === 0 ? (
          <span className="door-none">no open ports</span>
        ) : (
          data.ports.map((p, i) => {
            const bind = p.target || p.published;
            return (
              <CopyText key={i} text={`${data.ip}:${bind}`}>
                <span className={cn("door", p.published && "door-pub")}>
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

function LabeledEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {typeof data?.label === "string" && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { zone: ZoneNode, bridge: BridgeNode, attacker: AttackerNode, computer: ComputerNode, hostport: HostPortNode };
const edgeTypes = { link: LabeledEdge };

const GREY = "#4f4f4f";
function link(id: string, source: string, target: string, color: string, animated = false, label?: string): Edge {
  return {
    id,
    source,
    target,
    type: "link",
    animated,
    data: label ? { label } : undefined,
    style: { stroke: color, strokeWidth: 1.8, strokeDasharray: animated ? "5 5" : undefined, opacity: color === GREY ? 0.8 : 1 },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
  };
}

/** Build zones + bridges + machines. Machines plug into their network's bridge. */
// Approximate rendered sizes, for dagre layout + enclosing zones.
const SIZE: Record<string, { w: number; h: number }> = {
  attacker: { w: 196, h: 140 },
  computer: { w: 238, h: 206 },
  bridge: { w: 136, h: 60 },
};

/** Build zones + bridges + machines, laid out as a left-to-right dagre tree:
 *  attack bridge → attack box → lab bridge → each target host. */
function build(machines: Machine[], attacker: Attacker, subnet: string | null): { nodes: Node[]; edges: Edge[] } {
  const atkOn = !!attacker?.running;
  const pivotColor = atkOn ? attack : "#5a5a5a";
  const exposed = machines.filter((m) => m.ports.some((p) => p.published > 0)).length;

  type Core = { id: string; type: "attacker" | "computer" | "bridge"; data: Record<string, unknown> };
  const core: Core[] = [
    { id: "bridge-attack", type: "bridge", data: { label: "attack bridge", tone: "attack" } },
    { id: "__attacker", type: "attacker", data: { label: "Attack box", subtitle: atkOn ? attacker!.ip : "not started", running: atkOn } },
    { id: "bridge-lab", type: "bridge", data: { label: "lab bridge" } },
  ];
  const edges: Edge[] = [
    link("e-attbr", "bridge-attack", "__attacker", GREY),
    link("e-pivot", "__attacker", "bridge-lab", pivotColor, atkOn, "attacks"),
  ];
  machines.forEach((m) => {
    const type = serviceType(m.image, m.name);
    const id = `svc-${m.name}`;
    core.push({
      id,
      type: "computer",
      data: { hostname: m.name, image: m.image || serviceMeta[type].label, type, ip: m.ip || "resolving…", running: m.state === "running", ports: m.ports },
    });
    edges.push(link(`e-lab-${m.name}`, "bridge-lab", id, GREY));
  });

  // Dagre layout (top-to-bottom tree): attack bridge → attack box → lab bridge → hosts.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 66, nodesep: 36, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  core.forEach((n) => g.setNode(n.id, { width: SIZE[n.type].w, height: SIZE[n.type].h }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const pos = (id: string) => {
    const s = SIZE[core.find((c) => c.id === id)!.type];
    const p = g.node(id);
    return { x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h };
  };

  const nodes: Node[] = core.map((n) => {
    const p = pos(n.id);
    return {
      id: n.id,
      type: n.type,
      position: { x: p.x, y: p.y },
      data: n.data,
      ...(n.type === "bridge" ? { style: { width: p.w, height: p.h } } : {}),
      draggable: n.type !== "bridge",
    };
  });

  // Enclose each network's members in a zone (area) computed from the laid-out nodes.
  const rect = (ids: string[]) => {
    const ps = ids.map(pos);
    const minX = Math.min(...ps.map((p) => p.x));
    const minY = Math.min(...ps.map((p) => p.y));
    const maxX = Math.max(...ps.map((p) => p.x + p.w));
    const maxY = Math.max(...ps.map((p) => p.y + p.h));
    const pad = 22;
    return { x: minX - pad, y: minY - 30, width: maxX - minX + pad * 2, height: maxY - minY + pad + 30 };
  };
  const attackR = rect(["bridge-attack", "__attacker"]);
  const labR = rect(["bridge-lab", ...machines.map((m) => `svc-${m.name}`)]);

  // Localhost port bindings: a little node on the host-card edge (below the lab network),
  // linked up to the container it forwards to.
  const HP_W = 128;
  const hpY = labR.y + labR.height + 44;
  machines.forEach((m) => {
    const c = pos(`svc-${m.name}`);
    m.ports
      .filter((p) => p.published > 0)
      .forEach((p, k) => {
        const id = `hp-${m.name}-${p.published}`;
        nodes.push({
          id,
          type: "hostport",
          position: { x: c.x + c.w / 2 - HP_W / 2 + k * (HP_W + 16), y: hpY },
          style: { width: HP_W },
          data: { addr: `127.0.0.1:${p.published}` },
          draggable: false,
          selectable: false,
        });
        edges.push({
          id: `e-hp-${m.name}-${p.published}`,
          source: `svc-${m.name}`,
          target: id,
          type: "link",
          data: { label: "published" },
          style: { stroke: "#54c171", strokeWidth: 1.6, strokeDasharray: "4 4", opacity: 0.9 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#54c171", width: 14, height: 14 },
        });
      });
  });

  const zones: Node[] = [
    { id: "zone-attack", type: "zone", position: { x: attackR.x, y: attackR.y }, style: { width: attackR.width, height: attackR.height }, data: { label: "ATTACK NETWORK", tone: "attack" }, draggable: false, selectable: false },
    {
      id: "zone-lab",
      type: "zone",
      position: { x: labR.x, y: labR.y },
      style: { width: labR.width, height: labR.height },
      data: { label: subnet ? `LAB NETWORK · ${subnet} · ${machines.length} ${machines.length === 1 ? "host" : "hosts"} · ${exposed} exposed` : `LAB NETWORK · ${machines.length} ${machines.length === 1 ? "host" : "hosts"}` },
      draggable: false,
      selectable: false,
    },
  ];

  return { nodes: [...zones, ...nodes], edges };
}

function Flow({ machines, attacker, subnet }: { machines: Machine[]; attacker: Attacker; subnet: string | null }) {
  const { nodes: seedNodes, edges: seedEdges } = useMemo(() => build(machines, attacker, subnet), [machines, attacker, subnet]);
  const [nodes, , onNodesChange] = useNodesState(seedNodes);
  const [edges, , onEdgesChange] = useEdgesState(seedEdges);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      fitViewOptions={{ padding: 0.12, minZoom: 0.4, maxZoom: 1.1 }}
      minZoom={0.3}
      maxZoom={1.5}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#242424" />
    </ReactFlow>
  );
}

export function NetworkDiagram({ machines, attacker = null }: { machines: Machine[]; attacker?: Attacker }) {
  const firstIp = machines.map((m) => m.ip).find((ip) => isIp(ip || ""));
  const subnet = firstIp ? `${firstIp.split(".").slice(0, 2).join(".")}.0.0/16` : null;
  const sig =
    machines.map((m) => `${m.name}:${m.state}:${m.ip}:${m.ports.map((p) => `${p.published}-${p.target}`).join(",")}`).join("|") +
    `#${attacker?.running ? attacker.ip : "off"}`;

  return (
    <div className="hostcard">
      <div className="hostcard-header">
        <span className="hostcard-icon">
          <Laptop size={16} />
        </span>
        <div>
          <div className="hostcard-title">Your machine</div>
          <div className="hostcard-sub mono">127.0.0.1 · host</div>
        </div>
        <span className="hostcard-online">
          <i /> online
        </span>
      </div>

      <div className="topology-shell">
        <ReactFlowProvider>
          <Flow key={sig} machines={machines} attacker={attacker} subnet={subnet} />
        </ReactFlowProvider>
        <div className="topology-legend">
          <div>
            <DoorOpen size={12} /> <span>open port</span>
          </div>
          <div>
            <Plug size={12} className="legend-exposed" /> <span>published to 127.0.0.1</span>
          </div>
          <div>
            <Copy size={11} /> <span>click to copy</span>
          </div>
        </div>
      </div>
    </div>
  );
}
