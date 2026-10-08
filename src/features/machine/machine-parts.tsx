"use client";

import { type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SelfTest } from "@/features/machine/self-test";
import { cn } from "@/lib/utils";
import { StatusPill, type Tone } from "@/components/ui/status-pill";

// ---------- small parts ----------

/** The last minute of a 0-100 series as a thin line with a soft fill. */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={cn("h-7", className)} />;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - (Math.max(0, Math.min(100, v)) / 100) * 26 - 1}`);
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cn("h-7 w-full text-jewel-text", className)} aria-hidden>
      <polygon points={`0,28 ${pts.join(" ")} 100,28`} className="fill-current opacity-10" />
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function Stat({ icon: Icon, label, value, sub, history }: { icon: LucideIcon; label: string; value: string | null; sub: string; history: number[] }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[0.71875rem] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      {value === null ? (
        <>
          <Skeleton className="mt-2 h-6 w-16" />
          <Skeleton className="mt-2.5 h-7 w-full" />
        </>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-xl font-semibold tracking-tight tabular-nums">{value}</span>
            <span className="truncate text-[0.71875rem] tabular-nums text-muted-foreground">{sub}</span>
          </div>
          <Sparkline values={history} className="mt-1.5" />
        </>
      )}
    </div>
  );
}

/** A read-only tool row for the Details section. */
export function DetailRow({ name, value, bad }: { name: string; value: string; bad?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2 text-[0.78125rem] last:border-b-0">
      <span className="text-muted-foreground">{name}</span>
      <span className={cn("ml-auto font-mono text-[0.71875rem]", bad ? "text-warning" : "text-foreground")}>{value}</span>
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-2 p-3.5">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

// ---------- lab types ----------

export type LabKind = "docker" | "vm";

/** One lab type: what it runs on, whether it's ready, and the one action that matters. */
export function LabTypeRow({
  kind,
  icon,
  title,
  tone,
  status,
  detail,
  hint,
  actions,
  testing,
  onTestDone,
}: {
  kind: LabKind;
  icon: ReactNode;
  title: string;
  tone: Tone;
  status: string;
  detail: ReactNode;
  hint?: string;
  actions: ReactNode;
  testing: boolean;
  onTestDone: () => void;
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2.5 text-[0.8125rem] font-medium">
            {title}
            <StatusPill tone={tone}>{status}</StatusPill>
          </p>
          <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{detail}</p>
          {hint && <p className="mt-1 text-[0.75rem] text-warning">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {testing && (
        <div className="px-3.5 pb-3.5">
          <SelfTest
            kind={kind}
            title={kind === "docker" ? "Container lab test" : "VM lab test"}
            description={kind === "docker" ? "Two containers on a lab network, then removed." : "Boots a real test VM, checks it, then deletes it."}
            auto
            onResult={(r) => {
              if (r === "ok" || r === "fail") onTestDone();
            }}
          />
        </div>
      )}
    </div>
  );
}
