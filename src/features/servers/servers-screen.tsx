"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus, RefreshCw } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  SERVER_CHANGED,
  serverCapacity,
  serverList,
  serverOpenSetup,
  serverRemove,
  serverRunningLabs,
  serverSetDefault,
  serverTest,
  systemCheck,
  type HostCapacity,
  type ServerHost,
  type ServerTest,
  type SystemReport,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { HostRow } from "@/features/servers/host-row";
import { EmptyState, Tone } from "@/features/servers/servers-parts";
import { VmTest, loadVmTests, saveVmTest } from "@/features/servers/vm-tests";

type Tab = "setup";

export function ago(at: number, now: number) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

const GB = 1e9;
export const fmtGb = (b: number) => `${b >= 10 * GB ? Math.round(b / GB) : (b / GB).toFixed(1)} GB`;

// ---------- screen ----------

export function ServerScreen({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const [allHosts, setHosts] = useState<ServerHost[] | null>(null);
  const hosts = allHosts?.filter((h) => h.provider !== "aws") ?? null;
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ServerTest | "testing">>({});
  const [vmTestId, setVmTestId] = useState<string | null>(null);
  const [vmResults, setVmResults] = useState<Record<string, VmTest>>(() => loadVmTests());
  const [running, setRunning] = useState<Record<string, number>>({});
  const [caps, setCaps] = useState<Record<string, HostCapacity | null>>({});
  const [report, setReport] = useState<SystemReport | null>(null);
  // Relative "Xm ago" labels, refreshed on a slow tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const test = useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const r = await serverTest(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) } }));
    }
  }, []);

  const loadCapacity = useCallback((id: string) => {
    serverCapacity(id)
      .then((c) => setCaps((m) => ({ ...m, [id]: c })))
      .catch(() => {});
  }, []);

  // Auto-test and probe capacity for every host as it loads, so the row is live without a
  // click. The `seen` guard keeps a host from re-running these on every render.
  const seen = useRef<Set<string>>(new Set());
  const reload = useCallback(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        setDefaultId(l.default);
        setError(null);
        for (const h of l.hosts) {
          if (!seen.current.has(h.id)) {
            seen.current.add(h.id);
            test(h.id);
            loadCapacity(h.id);
          }
        }
      })
      .catch((e) => setError(String(e)));
  }, [test, loadCapacity]);
  useEffect(reload, [reload]);

  useEffect(() => {
    systemCheck()
      .then(setReport)
      .catch(() => {});
  }, []);

  // Running-labs-per-host, refreshed on a slow poll (labs start and stop from other screens).
  const loadRunning = useCallback(() => {
    serverRunningLabs()
      .then(setRunning)
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadRunning();
    const timer = setInterval(loadRunning, 8000);
    return () => clearInterval(timer);
  }, [loadRunning]);

  // The setup window saves hosts; refresh (and re-probe the changed one) when it says so.
  useEffect(() => {
    const off = listen(SERVER_CHANGED, () => {
      seen.current.clear();
      reload();
      loadRunning();
    });
    return () => {
      off.then((f) => f()).catch(() => {});
    };
  }, [reload, loadRunning]);

  const open = (id: string | null) => serverOpenSetup(id, "server").catch((e) => setError(String(e)));
  const testAll = () => hosts?.forEach((h) => test(h.id));
  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const online = hosts?.filter((h) => tests[h.id] && tests[h.id] !== "testing" && (tests[h.id] as ServerTest).ok).length ?? 0;
  const anyTesting = !!hosts?.some((h) => tests[h.id] === "testing");
  const hasHosts = !!hosts && hosts.length > 0;
  const summaryTone: Tone = !hasHosts ? "warn" : anyTesting ? "muted" : online === hosts!.length ? "ok" : online > 0 ? "warn" : "fail";
  const summaryText = !hasHosts ? "No server connected" : anyTesting ? "Checking…" : `${online} of ${hosts!.length} online`;
  const canRunVmHere = !!report && report.vmProviders.some((p) => !p.remote && p.available && p.hypervisor !== false);

  return (
    <div className="space-y-5">
      {/* Summary strip, matching the machine page: status pill, muted meta, actions pinned right. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium",
            summaryTone === "ok"
              ? "border-emerald-500/30 text-emerald-500"
              : summaryTone === "fail"
                ? "border-rose-500/30 text-rose-500"
                : summaryTone === "muted"
                  ? "border-border text-muted-foreground"
                  : "border-amber-500/30 text-amber-500",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              summaryTone === "ok"
                ? "bg-emerald-500"
                : summaryTone === "fail"
                  ? "bg-rose-500"
                  : summaryTone === "muted"
                    ? "bg-muted-foreground/50"
                    : "bg-amber-500",
            )}
          />
          {summaryText}
        </span>
        <span className="text-[12px] text-muted-foreground">Proxmox or ESXi, over your network</span>
        <div className="ml-auto flex items-center gap-2">
          {hasHosts && (
            <Button variant="outline" size="sm" onClick={testAll} disabled={anyTesting}>
              {anyTesting ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} Test all
            </Button>
          )}
          <Button variant="learn" size="sm" onClick={() => open(null)}>
            <Plus className="size-3.5" /> Add host
          </Button>
        </div>
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

      {/* Hosts: the hero. */}
      <Panel>
        <PanelHeader
          title="Hosts"
          action={
            hasHosts ? (
              <span className="text-[11.5px] tabular-nums text-muted-foreground">
                {hosts!.length} host{hosts!.length > 1 ? "s" : ""}
              </span>
            ) : undefined
          }
        />
        {hosts === null ? (
          <div className="space-y-2 p-3.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !hasHosts ? (
          <EmptyState onAdd={() => open(null)} />
        ) : (
          hosts.map((h) => (
            <HostRow
              key={h.id}
              host={h}
              isDefault={h.id === defaultId}
              running={running[h.id] ?? 0}
              capacity={caps[h.id]}
              test={tests[h.id]}
              lastVm={vmResults[h.id]}
              now={now}
              vmTesting={vmTestId === h.id}
              onTest={() => test(h.id)}
              onVmTest={() => setVmTestId(vmTestId === h.id ? null : h.id)}
              onVmTestDone={(result) => {
                setVmResults(saveVmTest(h.id, result));
                test(h.id);
                loadRunning();
              }}
              onEdit={() => open(h.id)}
              onDefault={() => act(() => serverSetDefault(h.id === defaultId ? null : h.id))}
              onRemove={() => {
                if (confirm(`Remove ${h.name}? Its password is deleted from the keychain.`)) act(() => serverRemove(h.id));
              }}
            />
          ))
        )}
      </Panel>

      {/* Only worth suggesting when this machine can't already run VM labs itself. */}
      {report && !canRunVmHere && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">
            No server? If this machine can handle it, install a local hypervisor and run VM labs here.
          </p>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("setup")}>
            Set up this machine
          </Button>
        </div>
      )}
    </div>
  );
}
