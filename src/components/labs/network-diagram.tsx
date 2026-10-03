"use client";

import { cn } from "@/lib/utils";

type Machine = { name: string; state: string; ports: number[] };

/**
 * Live topology of a running lab: each container as a node inside the lab's Docker
 * network (dashed boundary), with flowing edges from "Your machine" (127.0.0.1) to the
 * services that publish a port. Internal-only services sit in the network, unconnected
 * to the host. Pure theme-aware SVG, scales to its container.
 */
export function NetworkDiagram({ machines, className }: { machines: Machine[]; className?: string }) {
  const n = machines.length;
  if (n === 0) return null;

  const boxW = 144;
  const boxH = 66;
  const gap = 26;
  const H = 236;
  const W = Math.max(660, n * boxW + (n - 1) * gap + 120);

  const hostW = 196;
  const hostH = 48;
  const hostX = W / 2 - hostW / 2;
  const hostY = 14;
  const hostCx = W / 2;
  const hostBottom = hostY + hostH;

  const netX = 24;
  const netY = 112;
  const netW = W - 48;
  const netH = 108;
  const nodeY = netY + 28;

  const total = n * boxW + (n - 1) * gap;
  const startX = (W - total) / 2;
  const nodes = machines.map((m, i) => {
    const x = startX + i * (boxW + gap);
    return { m, x, cx: x + boxW / 2 };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className={cn("w-full", className)}>
      {/* host -> published service edges */}
      {nodes.map(({ m, cx }) =>
        m.ports.length > 0 ? (
          <g key={`edge-${m.name}`}>
            <line x1={hostCx} y1={hostBottom} x2={cx} y2={nodeY} className="animate-dash stroke-learn" strokeOpacity={0.6} strokeWidth={1.5} />
            <text x={(hostCx + cx) / 2 + 8} y={(hostBottom + nodeY) / 2} className="fill-muted-foreground font-mono text-[10px]">
              :{Math.min(...m.ports)}
            </text>
          </g>
        ) : null,
      )}

      {/* lab network boundary */}
      <rect x={netX} y={netY} width={netW} height={netH} rx={12} fill="none" className="stroke-border" strokeDasharray="5 5" />
      <text x={netX + 13} y={netY + 19} className="fill-muted-foreground text-[11px]">lab network</text>

      {/* host */}
      <rect x={hostX} y={hostY} width={hostW} height={hostH} rx={10} className="fill-[#141414] stroke-border" />
      <text x={hostCx} y={hostY + 20} textAnchor="middle" className="fill-foreground text-[12.5px] font-medium">Your machine</text>
      <text x={hostCx} y={hostY + 35} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">127.0.0.1</text>

      {/* services */}
      {nodes.map(({ m, x, cx }) => (
        <g key={m.name}>
          <rect x={x} y={nodeY} width={boxW} height={boxH} rx={10} className="fill-[#141414] stroke-border" />
          <circle cx={x + boxW - 15} cy={nodeY + 15} r={3.5} className={m.state === "running" ? "fill-emerald-500" : "fill-muted-foreground"} />
          <text x={cx} y={nodeY + 31} textAnchor="middle" className="fill-foreground text-[12.5px] font-medium">{m.name}</text>
          <text x={cx} y={nodeY + 48} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">
            {m.ports.length ? m.ports.map((p) => `:${p}`).join("  ") : "internal"}
          </text>
        </g>
      ))}
    </svg>
  );
}
