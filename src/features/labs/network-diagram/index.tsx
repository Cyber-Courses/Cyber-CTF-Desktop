"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Laptop, Plug, Server } from "lucide-react";
import type { LabNetwork } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/lib/i18n";
import { edgeTypes } from "@/features/labs/network-diagram/edges";
import { layout } from "@/features/labs/network-diagram/layout";
import { ANCHOR, Attacker, Bounds, MIN_ZOOM, Machine } from "@/features/labs/network-diagram/model";
import { CopyText, nodeTypes } from "@/features/labs/network-diagram/nodes";
import { Topology, topology } from "@/features/labs/network-diagram/topology";

// The lab network diagram. Facts come from Docker (networks, interfaces, ports) or the lab's
// declarations (services); ELK lays them out (topology.ts -> layout.ts), React Flow draws them
// (nodes.tsx, edges.tsx). Each network is a zone with its bridge on the top edge, uplinked
// under the card header when it has a route out; machines on one network sit in its zone, a
// machine on several (a pivot) sits between them in attack order. The attack box is a host on
// the network it joined. Published ports are tabs on the card's bottom edge (the host's wall).

/** Below this the cards can't be read: a wider lab scrolls sideways instead of shrinking. */

type Tab = { id: string; port: number; left: number };

function Flow({
  topo,
  onSize,
  onTabs,
  width: shellW,
  height: shellH,
}: {
  topo: Topology;
  onSize: (w: number, h: number) => void;
  onTabs: (tabs: Tab[]) => void;
  width: number;
  height: number;
}) {
  // First pass renders the nodes invisibly so React Flow measures them; then ELK lays them out
  // with their real sizes (a card grows with its interfaces and ports).
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(topo.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const measured = useNodesInitialized();
  const { getNode, getInternalNode, setViewport } = useReactFlow();
  const [ready, setReady] = useState(false);
  const [bounds, setBounds] = useState<Bounds | null>(null);

  useEffect(() => {
    if (!measured || ready) return;
    let live = true;
    const size = (id: string) => {
      const n = getNode(id);
      return { w: n?.measured?.width ?? 200, h: n?.measured?.height ?? 120 };
    };
    // Where a link leaves a node from a named handle (a published port's, on its service's
    // box): the handle's outer middle, relative to the node, as React Flow measured it.
    const handleAt = (id: string, handle: string) => {
      const b = getInternalNode(id)?.internals.handleBounds?.source?.find((h) => h.id === handle);
      return b ? { x: b.x + b.width, y: b.y + b.height / 2 } : undefined;
    };
    layout(topo, size, handleAt)
      .then(({ boxes, routes, bounds: laid }) => {
        if (!live) return;
        const zones: Node[] = topo.zones.map((z) => {
          const b = boxes.get(z.id)!;
          const br = boxes.get(z.members[0]);
          // Widen a narrow segment (evenly, so its contents stay centred) until the label at the
          // left end of the top edge clears the centred bridge. 9px caps ≈ 6.4px a character.
          // Two lines: the name in 9px caps (≈ 6.4px a character), the detail in 9.5px mono (≈ 5.8px).
          const labelW = Math.max(String(z.data.label).length * 6.4 + (z.data.isolated ? 92 : 0), String(z.data.detail ?? "").length * 5.8) + 22;
          const w = Math.max(b.w, (br?.w ?? 0) + 2 * (14 + labelW + 12));
          const x = b.x - (w - b.w) / 2;
          // The bridge sits in the middle of the segment's top edge, like a gateway: the frame
          // starts at the bridge's centre line.
          const top = br ? br.y + br.h / 2 : b.y;
          if (br) {
            br.x = x + w / 2 - br.w / 2;
            // Re-draw the bridge's links as a bus from its new centre: down, across, down.
            const sx = x + w / 2;
            const sy = br.y + br.h;
            topo.edges
              .filter((e) => e.source === z.members[0])
              .forEach((e) => {
                const r = routes.get(e.id);
                if (!r) return;
                const end = r[r.length - 1];
                const busY = Math.min(sy + 20, end.y - 12);
                routes.set(e.id, Math.abs(end.x - sx) < 1 ? [{ x: sx, y: sy }, end] : [{ x: sx, y: sy }, { x: sx, y: busY }, { x: end.x, y: busY }, end]);
              });
          }
          // Side ports stay where ELK routed the pivot links (moved out with a widened frame).
          const side = (h: "w" | "e") => {
            const e = topo.edges.find((e) => (h === "e" ? e.source === z.id && e.sourceHandle === "e" : e.target === z.id && e.targetHandle === "w"));
            const r = e && routes.get(e.id);
            if (!r) return undefined;
            const pt = h === "e" ? r[0] : r[r.length - 1];
            pt.x = h === "e" ? x + w : x;
            return pt.y - top;
          };
          return {
            id: z.id,
            type: "zone",
            position: { x, y: top },
            style: { width: w, height: b.y + b.h - top },
            data: { ...z.data, labelLeft: 14, portW: side("w"), portE: side("e") },
            draggable: false,
            selectable: false,
          };
        });
        // Uplinks: straight up from each (centred) bridge to a point far above the view, so
        // the line slides under the card header without showing where it lands.
        topo.edges
          .filter((e) => e.source.startsWith("up-"))
          .forEach((e) => {
            const br = boxes.get(e.target);
            if (!br) return;
            const cx = br.x + br.w / 2;
            boxes.set(e.source, { x: cx - ANCHOR / 2, y: br.y - 2000, w: ANCHOR, h: ANCHOR });
            routes.set(e.id, [
              { x: cx, y: br.y - 2000 + ANCHOR },
              { x: cx, y: br.y },
            ]);
          });
        setNodes([...zones, ...topo.nodes.map((n) => ({ ...n, position: { x: boxes.get(n.id)?.x ?? 0, y: boxes.get(n.id)?.y ?? 0 } }))]);
        setEdges(topo.edges.map((e) => ({ ...e, data: { ...e.data, route: routes.get(e.id) } })));
        // Widened zones can reach past what ELK laid out: frame the final shapes.
        const x0 = Math.min(laid.x, ...zones.map((z) => z.position.x));
        const x1 = Math.max(laid.x + laid.w, ...zones.map((z) => z.position.x + Number(z.style?.width ?? 0)));
        const final = { ...laid, x: x0, w: x1 - x0 };
        setBounds(final);
        onSize(final.w, final.h + (final.docked ? 26 : 50));
        setReady(true);
      })
      .catch((e) => {
        console.warn("network diagram layout failed", e);
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [measured, ready, topo, getNode, getInternalNode, setNodes, setEdges, onSize]);

  // Fit once laid out, and again whenever the shell changes size. With published ports, their
  // anchors sit exactly on the bottom edge of the card (your machine): ports in its wall.
  const view = useMemo(() => {
    if (!ready || !bounds || !shellW || !shellH) return null;
    const side = 24;
    const top = 26;
    const bottom = bounds.docked ? 0 : 24;
    const zoom = Math.min(1.05, (shellW - 2 * side) / Math.max(bounds.w, 1), (shellH - top - bottom) / Math.max(bounds.h, 1));
    const x = (shellW - bounds.w * zoom) / 2 - bounds.x * zoom;
    const y = bounds.docked ? shellH - (bounds.y + bounds.h) * zoom : (shellH - bounds.h * zoom) / 2 - bounds.y * zoom;
    return { x, y, zoom };
  }, [ready, bounds, shellW, shellH]);
  useEffect(() => {
    if (view) setViewport(view);
  }, [view, setViewport]);

  // Published ports as tabs over the card's bottom edge, each under its link's anchor. The card
  // draws them, outside the scroller, so they can hang over its bottom edge.
  useEffect(() => {
    onTabs(
      ready && view
        ? nodes
            .filter((n) => n.type === "hostport")
            .map((n) => ({ id: n.id, port: Number((n.data as { port: number }).port), left: (n.position.x + ANCHOR / 2) * view.zoom + view.x }))
        : [],
    );
  }, [ready, view, nodes, onTabs]);

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
      // A fitted picture, not a canvas: panning or zooming would slide the ports off the edge.
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      panOnScroll={false}
      preventScrolling={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--input)" />
    </ReactFlow>
  );
}

export function NetworkDiagram({
  machines,
  networks = [],
  attacker = null,
  host = null,
}: {
  machines: Machine[];
  networks?: LabNetwork[];
  attacker?: Attacker;
  host?: string | null;
}) {
  const t = useT();
  // The labels are drawn in the current language: a language change re-lays them out too.
  const locale = useLocale();
  // Re-layout only when the topology changes (not on every status poll).
  const sig =
    `${locale}#` +
    machines
      .map(
        (m) =>
          `${m.name}:${m.state}:${m.ip}:${(m.interfaces ?? []).map((i) => `${i.network}=${i.ip}`).join(",")}:${(m.services ?? []).map((v) => `${v.name}=${v.kind}/${v.ports.join("+")}`).join(",")}:${m.ports.map((p) => `${p.published}-${p.target}`).join(",")}`,
      )
      .join("|") +
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
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [scrollX, setScrollX] = useState(0);
  // onSize gets the drawing's size plus its vertical margins; the side margins are 24px each.
  // A wide lab is never shrunk below a readable zoom: its canvas grows past the card instead,
  // and the card scrolls sideways (trackpad, shift+wheel, scrollbar).
  const fit = graph && width ? Math.min(1.05, (width - 48) / Math.max(graph.w, 1)) : 1;
  const scale = Math.max(fit, MIN_ZOOM);
  const canvas = graph && width ? Math.max(width, Math.ceil(graph.w * scale + 48)) : width;
  const height = graph ? Math.round(Math.min(720, Math.max(220, graph.h * scale))) : 430;

  return (
    <div className={cn("hostcard", machines.some((m) => m.ports.some((p) => p.published > 0)) && "hostcard-docked")}>
      <div className="hostcard-header">
        <span className="hostcard-icon">{host ? <Server size={16} /> : <Laptop size={16} />}</span>
        <div>
          <div className="hostcard-title">{host ?? t("diagram.host.yourMachine")}</div>
          <div className="hostcard-sub mono">
            {host ? (
              t("diagram.host.serverSub")
            ) : (
              <>
                <CopyText text="127.0.0.1">127.0.0.1</CopyText> · {t("diagram.host.host")}
              </>
            )}
          </div>
        </div>
        <span className="hostcard-online">
          <i /> {t("diagram.host.online")}
        </span>
      </div>

      <div
        ref={shell}
        className="topology-shell"
        style={{ height }}
        // Fades on the sides that have more to scroll to, so a wide lab reads as scrollable.
        data-more-left={scrollX > 1 || undefined}
        data-more-right={canvas - width - scrollX > 1 || undefined}
      >
        <div className="topology-scroll" onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}>
          <div className="topology-canvas" style={{ width: canvas || "100%" }}>
            <ReactFlowProvider key={sig}>
              <Flow topo={topo} onSize={onSize} onTabs={setTabs} width={canvas} height={height} />
            </ReactFlowProvider>
          </div>
        </div>
        <div className="port-tabs">
          {tabs.map((tab) => (
            <span
              key={tab.id}
              className="port-tab"
              style={{ left: tab.left - scrollX }}
              title={t("diagram.host.portTab", { url: `http://127.0.0.1:${tab.port}` })}
            >
              <CopyText text={`http://127.0.0.1:${tab.port}`}>
                <Plug size={11} />
                <span className="mono">:{tab.port}</span>
              </CopyText>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
