import { Box, Database, Globe2, Terminal, Workflow, Zap, type LucideIcon } from "lucide-react";
import type { LabInterface, LabMachine } from "@/lib/tauri";

// Shared types, colours and helpers for the lab network diagram.

type Port = { published: number; target: number };
export type Machine = LabMachine;
export type Attacker = { running: boolean; ip: string; labNetwork?: string } | null;

// Colours are CSS custom properties (globals.css), so the diagram follows Dark, Black and Light.
export const attack = "var(--you)"; // violet: you, the attacker, and your link into the lab network

export function isIp(s: string) {
  return /^\d{1,3}\.\d{1,3}\./.test(s);
}

/** Docker lists a published port once per address family (0.0.0.0 and ::): keep one. */
export function uniquePorts(ports: Port[]) {
  return ports.filter((p, i) => ports.findIndex((q) => q.published === p.published && q.target === p.target) === i);
}

/** Compose's implicit network is "default"; to a player it's just the lab network. */
export function netLabel(name: string) {
  return name === "default" ? "lab" : name;
}

/** A dashed network segment (area) that frames the nodes inside it. */
/** `label` is the network's name; `detail` (its subnet) goes on a second line. */
export type ZoneData = { label: string; detail?: string; tone?: "attack"; isolated?: boolean; labelLeft?: number; portW?: number; portE?: number };

type ServiceType = "database" | "web" | "cache" | "worker" | "ssh" | "service";
/** One row of a machine card: a service and the ports it listens on. */
export type ServiceRow = { title: string; type: ServiceType; label: string; ports: Port[] };
export type ComputerData = {
  hostname: string;
  image: string;
  type: ServiceType;
  ifaces: LabInterface[];
  running: boolean;
  state: string;
  ports: Port[];
  rows: ServiceRow[];
};

export const serviceMeta: Record<ServiceType, { icon: LucideIcon; label: string; color: string }> = {
  database: { icon: Database, label: "database", color: "var(--hue-sky)" },
  web: { icon: Globe2, label: "web / api", color: "var(--hue-violet)" },
  cache: { icon: Zap, label: "cache", color: "var(--hue-amber)" },
  worker: { icon: Workflow, label: "worker", color: "var(--hue-grey)" },
  ssh: { icon: Terminal, label: "ssh", color: "var(--hue-mint)" },
  service: { icon: Box, label: "service", color: "var(--hue-grey)" },
};

/** A declared kind, mapped onto the known looks; anything else is a plain service. */
function declaredType(kind: string): ServiceType {
  const k = kind.toLowerCase();
  return k === "database" || k === "web" || k === "cache" || k === "worker" || k === "ssh" ? k : "service";
}

/** The card's service rows. Declared services (compose labels) each get a row with their
 *  ports. Container ports none of them claims are left out: they are the image's own EXPOSE
 *  defaults (a MySQL image exposes 3306/33060 even when the lab's database listens on 3207),
 *  not lab services, and listing them as "other ports" only sends the player to doors that
 *  aren't open. With nothing declared, one row: the image, its look, every port. */
export function serviceRows(m: Machine, ports: Port[], fallback: ServiceType): ServiceRow[] {
  const declared = m.services ?? [];
  if (declared.length === 0) return [{ title: m.image || serviceMeta[fallback].label, type: fallback, label: serviceMeta[fallback].label, ports }];
  const byTarget = (n: number) => ports.find((p) => (p.target || p.published) === n) ?? { published: 0, target: n };
  return declared.map((d) => ({ title: d.name, type: declaredType(d.kind), label: d.kind || "service", ports: d.ports.map(byTarget) }));
}

export function serviceType(image: string, name: string): ServiceType {
  const s = `${image} ${name}`.toLowerCase();
  if (/(maria|mysql|postgres|psql|mongo|sqlite|mssql|cassandra|database|[-_]db\b|^db)/.test(s)) return "database";
  if (/(redis|memcache|cache|valkey)/.test(s)) return "cache";
  if (/(nginx|caddy|apache|httpd|web|api|frontend|portal|gateway|proxy|node|php|python|flask|django|rails)/.test(s)) return "web";
  if (/(worker|queue|rabbit|kafka|job|cron|evidence|seed|init|place|curl)/.test(s)) return "worker";
  return "service";
}

/** One service row: what it is, and the ports it listens on (inside the container). Publishing
 *  to the host is shown once, by the 127.0.0.1 node below, not here too. */

export type Pt = { x: number; y: number };

export type LinkData = { label?: string; route?: Pt[] };

export const GREY = "var(--edge-line)";
export const GREEN = "var(--success)";
export const PIVOT = "var(--jewel)"; // a pivot's link on into a deeper network
export const IDLE = "var(--faint)"; // a link that is not live (attack box not attached)

export const BRIDGE = { w: 136, h: 60 };
export const ANCHOR = 2; // a published port's anchor node, a point on the card's edge

/** The lab as a graph: zones (networks) holding bridges and single-homed machines, pivots
 *  between zones, the attack zone on top and localhost bindings below. Positions come later. */

export type Bounds = { x: number; y: number; w: number; h: number; docked: boolean };
