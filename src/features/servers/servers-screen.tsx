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
import { PageHeader } from "@/components/ui/page-header";
import { Meter } from "@/components/ui/meter";
import { formatBytes } from "@/lib/format";
import { HostRow } from "@/features/servers/host-row";
import { ServersEmptyState } from "@/features/servers/servers-empty-state";
import { StatusDot, type Tone } from "@/components/ui/status-pill";
import { VmTest, loadVmTests, saveVmTest } from "@/features/servers/vm-tests";
import { ignore, warn } from "@/lib/failure";
import { useT } from "@/lib/i18n";

type Tab = "setup";

// ---------- screen ----------

export function ServerScreen({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const t = useT();
  const [allHosts, setHosts] = useState<ServerHost[] | null>(null);
  // Cloud accounts (AWS/Azure/GCP) live on the Cloud page; the Servers page is on-prem hosts only.
  const hosts = allHosts?.filter((h) => h.provider !== "aws" && h.provider !== "azure" && h.provider !== "gcp") ?? null;
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
      setTests((t) => ({ ...t, [id]: { ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e), checks: [] } }));
    }
  }, []);

  const loadCapacity = useCallback((id: string) => {
    serverCapacity(id)
      .then((c) => setCaps((m) => ({ ...m, [id]: c })))
      .catch(ignore("capacity is shown only when it can be read"));
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
    systemCheck().then(setReport).catch(warn("system check"));
  }, []);

  // Running-labs-per-host, refreshed on a slow poll (labs start and stop from other screens).
  const loadRunning = useCallback(() => {
    serverRunningLabs()
      .then((r) => setRunning(r ?? {}))
      .catch(ignore("read again on the next server change"));
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
      off.then((f) => f()).catch(ignore("the listener never got set up"));
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
  const summaryText = !hasHosts
    ? t("servers.screen.noServer")
    : anyTesting
      ? t("servers.screen.checking")
      : t("servers.screen.onlineCount", { online, total: hosts!.length });
  const canRunVmHere = !!report && report.vmProviders.some((p) => !p.remote && p.available && p.hypervisor !== false);

  // Capacity panel: the default host when it answered, else the first host that did.
  const capHost = hosts?.find((h) => h.id === defaultId && caps[h.id]) ?? hosts?.find((h) => caps[h.id]) ?? null;
  const cap = capHost ? caps[capHost.id] : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("servers.screen.title")}
        lead={t("servers.screen.lead")}
        actions={
          <>
            {hasHosts && (
              <Button variant="outline" size="sm" onClick={testAll} disabled={anyTesting}>
                {anyTesting ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} {t("servers.screen.testAll")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => open(null)}>
              <Plus className="size-3.5" /> {t("servers.screen.addServer")}
            </Button>
          </>
        }
      />

      {error && (
        <Panel>
          <div className="flex items-start gap-3 px-4 py-3 text-[0.8125rem]">
            <StatusDot tone="fail" className="mt-1.5" />
            <p className="min-w-0 break-words text-muted-foreground">{error}</p>
          </div>
        </Panel>
      )}

      {hosts === null ? (
        <Panel>
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </Panel>
      ) : !hasHosts ? (
        <ServersEmptyState onAdd={() => open(null)} />
      ) : (
        <Panel>
          <PanelHeader
            title={
              <>
                <StatusDot tone={summaryTone} pulse={anyTesting} />
                {t("servers.screen.hosts")}
              </>
            }
            meta={`${summaryText} · ${t("servers.screen.hostCount", { count: hosts.length })}`}
          />
          {hosts.map((h) => (
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
                if (confirm(t("servers.screen.removeConfirm", { name: h.name }))) act(() => serverRemove(h.id));
              }}
            />
          ))}
        </Panel>
      )}

      {capHost && cap && (
        <Panel>
          <PanelHeader title={t("servers.screen.capacityTitle", { name: capHost.name })} meta={t("servers.screen.vcpu", { count: cap.cores })} />
          <div className="grid gap-3 p-4">
            <div className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-4 text-[0.8125rem]">
              <span className="text-muted-foreground">{t("servers.screen.memory")}</span>
              <Meter value={cap.memTotal > 0 ? ((cap.memTotal - cap.memFree) / cap.memTotal) * 100 : 0} />
              <span className="text-right font-mono text-[0.6875rem] text-faint">
                {t("servers.screen.memoryUsed", { used: formatBytes(cap.memTotal - cap.memFree), total: formatBytes(cap.memTotal) })}
              </span>
            </div>
          </div>
        </Panel>
      )}

      {/* Only worth suggesting when this machine can't already run VM labs itself. */}
      {report && !canRunVmHere && (
        <Panel>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <StatusDot tone="muted" />
            <p className="min-w-0 flex-1 text-[0.8125rem] text-muted-foreground">{t("servers.screen.noServerHint")}</p>
            <Button variant="ghost" size="xs" onClick={() => onNavigate("setup")}>
              {t("servers.screen.setUpMachine")}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
