"use client";

import { ArrowDown, ArrowUpRight, Box, Crosshair, Database, Globe, Laptop, Monitor, Network, Server, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Port = { published: number; target: number };
type Machine = { name: string; state: string; image: string; ports: Port[] };

type Kind = { icon: LucideIcon; label: string; cls: string };

/** Infer the kind of software from the image (falls back to the service name). */
function classify(image: string, name: string): Kind {
  const s = `${image} ${name}`.toLowerCase();
  if (/(maria|mysql|postgres|psql|mongo|sqlite|mssql|cassandra|database|[-_]db\b|^db)/.test(s))
    return { icon: Database, label: "Database", cls: "border-sky-500/30 bg-sky-500/10 text-sky-400" };
  if (/(redis|memcache|cache|valkey)/.test(s))
    return { icon: Zap, label: "Cache", cls: "border-amber-500/30 bg-amber-500/10 text-amber-400" };
  if (/(nginx|caddy|apache|httpd|web|api|frontend|portal|gateway|proxy|node|php|python|flask|django|rails)/.test(s))
    return { icon: Globe, label: "Web service", cls: "border-learn/30 bg-learn/12 text-learn" };
  if (/(worker|queue|rabbit|kafka|job|cron|evidence|seed|init|place|curl)/.test(s))
    return { icon: Server, label: "Worker", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" };
  return { icon: Box, label: "Service", cls: "border-border bg-muted text-muted-foreground" };
}

/** A container = a small computer, showing the software (image) bound to a port inside. */
function ComputerNode({ m }: { m: Machine }) {
  const kind = classify(m.image, m.name);
  const Icon = kind.icon;
  const running = m.state === "running";
  const exposed = m.ports.find((p) => p.published > 0);
  const bound = exposed ?? m.ports[0];
  const software = m.image || kind.label;

  return (
    <div className="w-[216px] overflow-hidden rounded-xl border border-border bg-[#0f0f0f] transition-colors hover:border-ring/50">
      {/* the computer */}
      <div className="flex items-center gap-2 border-b border-border bg-[#151515] px-3 py-2">
        <Monitor className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[12px] font-medium text-foreground">{m.name}</span>
        <span className="relative ml-auto flex size-2">
          {running && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-70" />}
          <span className={cn("relative inline-flex size-2 rounded-full", running ? "bg-emerald-500" : "bg-muted-foreground/40")} />
        </span>
      </div>
      {/* the software inside, bound to a port */}
      <div className="space-y-2 p-2.5">
        <div className={cn("flex items-center gap-2 rounded-lg border px-2 py-1.5", kind.cls)}>
          <Icon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{software}</span>
          {bound?.target ? <span className="shrink-0 font-mono text-[11px]">:{bound.target}</span> : null}
        </div>
        {exposed ? (
          <p className="flex items-center gap-1 font-mono text-[10.5px] text-emerald-400">
            <ArrowUpRight className="size-3" /> 127.0.0.1:{exposed.published}
          </p>
        ) : (
          <p className="text-[10.5px] text-muted-foreground">internal only</p>
        )}
      </div>
    </div>
  );
}

/** The learner's offensive box (Exegol), on the same network as the targets. */
function AttackNode() {
  return (
    <div className="w-[216px] overflow-hidden rounded-xl border border-learn/40 bg-learn/[0.06] ring-1 ring-learn/10">
      <div className="flex items-center gap-2 border-b border-learn/25 bg-learn/10 px-3 py-2">
        <Crosshair className="size-4 shrink-0 text-learn" />
        <span className="truncate font-mono text-[12px] font-medium text-foreground">attacker</span>
        <span className="ml-auto rounded bg-learn/20 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-learn">You</span>
      </div>
      <div className="space-y-2 p-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-learn/30 bg-learn/10 px-2 py-1.5 text-learn">
          <Server className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">Exegol</span>
        </div>
        <p className="text-[10.5px] text-muted-foreground">your attack toolbox</p>
      </div>
    </div>
  );
}

export function NetworkDiagram({ machines, className }: { machines: Machine[]; className?: string }) {
  if (machines.length === 0) return null;
  const exposed = machines.filter((m) => m.ports.some((p) => p.published > 0)).length;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-[#151515] px-3.5 py-2.5">
        <span className="grid size-9 place-items-center rounded-lg border border-border bg-[#0c0c0c] text-foreground">
          <Laptop className="size-[18px]" />
        </span>
        <div className="leading-tight">
          <p className="text-[13px] font-medium">Your machine</p>
          <p className="font-mono text-[10.5px] text-muted-foreground">127.0.0.1</p>
        </div>
      </div>

      <div className="relative my-1.5 h-7 w-px overflow-hidden bg-border">
        <span className="absolute inset-x-[-1px] top-0 h-2 animate-[drip_1.3s_linear_infinite] bg-learn" />
      </div>

      <div className="w-full rounded-xl border border-dashed border-border bg-[#0b0b0b] p-4">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Network className="size-3.5" /> lab network
          <span className="ml-auto font-sans text-[10.5px] normal-case tracking-normal text-muted-foreground/70">
            {machines.length} {machines.length === 1 ? "computer" : "computers"} · {exposed} exposed
          </span>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <AttackNode />
          {machines.map((m) => (
            <ComputerNode key={m.name} m={m} />
          ))}
        </div>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-center text-[11px] text-muted-foreground">
        <ArrowDown className="size-3" /> You attack the target computers from Exegol; exposed services are also reachable at 127.0.0.1
      </p>
    </div>
  );
}
