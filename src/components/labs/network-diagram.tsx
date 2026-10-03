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
import { ArrowUpRight, Box, Check, Copy, Database, Globe2, Laptop, Monitor, Radio, ShieldCheck, Terminal, Workflow, Zap, type LucideIcon } from "lucide-react";

// A lab is a set of Docker containers (computers). "Your machine" (host) is the wrapping
// card; inside it the diagram shows two network zones — the attack network (where the
// attack box lives) and the lab network (the targets) — with the attack box reaching into
// the lab network. Targets are addressed by their container IP (click to copy).

type Port = { published: number; target: number };
type Machine = { name: string; state: string; image: string; ip: string; ports: Port[] };
type Attacker = { running: boolean; ip: string } | null;

const violet = "#a78bfa"; // web/api service accent
const attack = "#f0616d"; // red: the attacker and its attack paths

function isIp(s: string) {
  return /^\d{1,3}\.\d{1,3}\./.test(s);
}

/** A click-to-copy wrapper (for IPs / addresses). Stops React Flow from dragging the node. */
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
      <Handle type="target" position={Position.Left} className="topology-handle" style={{ "--handle-accent": accent } as React.CSSProperties} />
      <Handle type="source" position={Position.Right} className="topology-handle" style={{ "--handle-accent": accent } as React.CSSProperties} />
    </>
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
type ComputerData = { hostname: string; image: string; type: ServiceType; ip: string; port: number; exposed?: number; running: boolean };

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
      {/* the address the learner attacks, from the attack box */}
      <div className="computer-ip mono">{hasIp ? <CopyText text={`${data.ip}${data.port ? `:${data.port}` : ""}`}>{data.ip}{data.port ? `:${data.port}` : ""}</CopyText> : data.ip}</div>
      <div className="service-chip" style={{ "--service-color": meta.color } as React.CSSProperties}>
        <div className="service-icon">
          <ServiceIcon size={15} />
        </div>
        <div className="service-main">
          <span>{data.image}</span>
          <small>{meta.label}</small>
        </div>
        {data.port ? <span className="service-port mono">:{data.port}</span> : null}
      </div>
      {data.exposed ? (
        <div className="exposed-line">
          <ArrowUpRight size={13} />
          <CopyText text={`127.0.0.1:${data.exposed}`}>127.0.0.1:{data.exposed}</CopyText>
          <em>from host</em>
        </div>
      ) : null}
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

const nodeTypes = { zone: ZoneNode, attacker: AttackerNode, computer: ComputerNode };
const edgeTypes = { attack: LabeledEdge };

/** Build the two network zones (attack / lab) and the nodes inside them. */
function build(machines: Machine[], attacker: Attacker, subnet: string | null): { nodes: Node[]; edges: Edge[] } {
  const GAP = 182;
  const atkOn = !!attacker?.running;
  const atkColor = atkOn ? attack : "#5a5a5a";
  const exposed = machines.filter((m) => m.ports.some((p) => p.published > 0)).length;

  const labW = 468;
  const labH = Math.max(210, machines.length * GAP + 52);
  const atkW = 262;
  const atkH = 196;
  const labX = 330;
  // vertically center the attack zone against the lab zone
  const atkY = Math.max(0, labH / 2 - atkH / 2);

  const nodes: Node[] = [
    {
      id: "zone-attack",
      type: "zone",
      position: { x: 0, y: atkY },
      style: { width: atkW, height: atkH },
      data: { label: "ATTACK NETWORK", tone: "attack" },
      draggable: false,
      selectable: false,
    },
    {
      id: "zone-lab",
      type: "zone",
      position: { x: labX, y: 0 },
      style: { width: labW, height: labH },
      data: { label: subnet ? `LAB NETWORK · ${subnet} · ${machines.length} ${machines.length === 1 ? "host" : "hosts"} · ${exposed} exposed` : `LAB NETWORK · ${machines.length} ${machines.length === 1 ? "host" : "hosts"}` },
      draggable: false,
      selectable: false,
    },
    {
      id: "__attacker",
      type: "attacker",
      parentId: "zone-attack",
      extent: "parent",
      position: { x: 26, y: 56 },
      data: { label: "Attack box", subtitle: atkOn ? attacker!.ip : "not started", running: atkOn },
    },
  ];

  const edges: Edge[] = [];
  machines.forEach((m, i) => {
    const pub = m.ports.find((p) => p.published > 0);
    const bound = pub ?? m.ports[0];
    const type = serviceType(m.image, m.name);
    const id = `svc-${m.name}`;
    nodes.push({
      id,
      type: "computer",
      parentId: "zone-lab",
      extent: "parent",
      position: { x: 196, y: 44 + i * GAP },
      data: {
        hostname: m.name,
        image: m.image || serviceMeta[type].label,
        type,
        ip: m.ip || "resolving…",
        port: bound?.target || bound?.published || 0,
        exposed: pub?.published,
        running: m.state === "running",
      } satisfies ComputerData,
    });
    edges.push({
      id: `atk-${m.name}`,
      source: "__attacker",
      target: id,
      type: "attack",
      animated: atkOn,
      style: { stroke: atkColor, strokeWidth: 1.8, strokeDasharray: "5 5", opacity: atkOn ? 1 : 0.55 },
      markerEnd: { type: MarkerType.ArrowClosed, color: atkColor, width: 16, height: 16 },
    });
  });

  return { nodes, edges };
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
      fitViewOptions={{ padding: 0.14, minZoom: 0.4, maxZoom: 1.1 }}
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
      {/* "Your machine" IS the wrapping card */}
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
            <span className="legend-line attack-line" /> <span>attack path</span>
          </div>
          <div>
            <Copy size={11} className="legend-exposed" /> <span>click an IP to copy</span>
          </div>
        </div>
      </div>
    </div>
  );
}
