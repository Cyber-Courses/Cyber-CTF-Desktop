"use client";

import { useMemo } from "react";
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
import { ArrowUpRight, Box, Database, Globe2, Laptop, Monitor, Radio, ShieldCheck, Terminal, Workflow, Zap, type LucideIcon } from "lucide-react";

// A lab is a set of Docker containers (computers) on one private network. "Your machine"
// (the host) is the wrapping card; inside it the diagram shows the attacker (Exegol/Kali)
// and the target computers, each running software bound to a port.

type Port = { published: number; target: number };
type Machine = { name: string; state: string; image: string; ip: string; ports: Port[] };
type Attacker = { running: boolean; ip: string } | null;

const violet = "#a78bfa"; // web/api service accent
const attack = "#f0616d"; // red: the attacker and its attack paths

function PortHandles({ accent = "#6b7280" }: { accent?: string }) {
  return (
    <>
      <Handle type="target" position={Position.Left} className="topology-handle" style={{ "--handle-accent": accent } as React.CSSProperties} />
      <Handle type="source" position={Position.Right} className="topology-handle" style={{ "--handle-accent": accent } as React.CSSProperties} />
    </>
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
          {data.subtitle}
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
      <div className="computer-ip mono">{data.ip}</div>
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
          <span className="mono">127.0.0.1:{data.exposed}</span>
          <em>exposed</em>
        </div>
      ) : (
        <div className="internal-line">
          <Radio size={12} />
          <span>internal · </span>
          <span className="mono">
            {data.ip}:{data.port}
          </span>
        </div>
      )}
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

const nodeTypes = { attacker: AttackerNode, computer: ComputerNode };
const edgeTypes = { attack: LabeledEdge };

/** Build the attacker + target nodes (laid out inside the host card). */
function build(machines: Machine[], attacker: Attacker): { nodes: Node[]; edges: Edge[] } {
  const GAP = 176;
  const atkOn = !!attacker?.running;
  const atkColor = atkOn ? attack : "#5a5a5a";
  const colHeight = Math.max(GAP, machines.length * GAP);

  const nodes: Node[] = [
    {
      id: "__attacker",
      type: "attacker",
      position: { x: 20, y: Math.max(16, colHeight / 2 - 60) },
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
      position: { x: 340, y: 16 + i * GAP },
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
      style: { stroke: atkColor, strokeWidth: 1.8, strokeDasharray: "5 5", opacity: atkOn ? 1 : 0.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: atkColor, width: 16, height: 16 },
    });
  });

  return { nodes, edges };
}

function Flow({ machines, attacker }: { machines: Machine[]; attacker: Attacker }) {
  const { nodes: seedNodes, edges: seedEdges } = useMemo(() => build(machines, attacker), [machines, attacker]);
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
      fitViewOptions={{ padding: 0.16, minZoom: 0.5, maxZoom: 1.1 }}
      minZoom={0.35}
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
  const sig =
    machines.map((m) => `${m.name}:${m.state}:${m.ip}:${m.ports.map((p) => `${p.published}-${p.target}`).join(",")}`).join("|") +
    `#${attacker?.running ? attacker.ip : "off"}`;
  const exposed = machines.filter((m) => m.ports.some((p) => p.published > 0)).length;

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

      {/* the diagram lives inside the card */}
      <div className="topology-shell">
        <span className="netpill">
          lab network <span className="mono">172.20.0.0/16</span> · {machines.length} {machines.length === 1 ? "computer" : "computers"} · {exposed} exposed
        </span>
        <ReactFlowProvider>
          <Flow key={sig} machines={machines} attacker={attacker} />
        </ReactFlowProvider>
        <div className="topology-legend">
          <div>
            <span className="legend-line attack-line" /> <span>attack path</span>
          </div>
          <div>
            <ArrowUpRight size={12} className="legend-exposed" /> <span>exposed at <b className="mono">127.0.0.1</b></span>
          </div>
        </div>
      </div>
    </div>
  );
}
