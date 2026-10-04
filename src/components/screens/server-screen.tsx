"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Circle, Cpu, FlaskConical, MemoryStick, MoreHorizontal, Pencil, Plus, RefreshCw, Server, Star, Trash2, X } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { KIND } from "@/components/server/host-setup";
import {
  SERVER_CHANGED,
  serverCapacity,
  serverList,
  serverOpenSetup,
  serverRemove,
  serverRunningLabs,
  serverSelftest,
  serverSetDefault,
  serverTest,
  systemCheck,
  type HostCapacity,
  type SelfTestEvent,
  type ServerHost,
  type ServerTest,
  type SystemReport,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "setup";
type Tone = "ok" | "warn" | "fail" | "muted";

// ---------- last VM-test result, remembered per host (like the machine page) ----------

type VmTest = { result: "ok" | "fail"; at: number };
const VMTEST_KEY = "cyberctf.server.vmtest";

function loadVmTests(): Record<string, VmTest> {
  try {
    return JSON.parse(localStorage.getItem(VMTEST_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveVmTest(id: string, result: "ok" | "fail"): Record<string, VmTest> {
  const all = loadVmTests();
  all[id] = { result, at: Date.now() };
  try {
    localStorage.setItem(VMTEST_KEY, JSON.stringify(all));
  } catch {
    /* private window / blocked storage: the result just isn't remembered */
  }
  return all;
}

function ago(at: number, now: number) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

const GB = 1e9;
const fmtGb = (b: number) => `${b >= 10 * GB ? Math.round(b / GB) : (b / GB).toFixed(1)} GB`;

// ---------- small parts ----------

/** Dot + label, in the machine-page style, so status reads the same across the app. */
function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = { ok: "text-emerald-500", warn: "text-amber-500", fail: "text-rose-500", muted: "text-muted-foreground" }[tone];
  const dot = { ok: "bg-emerald-500", warn: "bg-amber-500", fail: "bg-rose-500", muted: "bg-muted-foreground/50" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", c)}>
      <span className={cn("size-1.5 rounded-full", dot)} />
      {children}
    </span>
  );
}

function TypeIcon({ children }: { children: ReactNode }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground">{children}</span>;
}

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
    serverCapacity(id).then((c) => setCaps((m) => ({ ...m, [id]: c }))).catch(() => {});
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
    systemCheck().then(setReport).catch(() => {});
  }, []);

  // Running-labs-per-host, refreshed on a slow poll (labs start and stop from other screens).
  const loadRunning = useCallback(() => {
    serverRunningLabs().then(setRunning).catch(() => {});
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
            summaryTone === "ok" ? "border-emerald-500/30 text-emerald-500" : summaryTone === "fail" ? "border-rose-500/30 text-rose-500" : summaryTone === "muted" ? "border-border text-muted-foreground" : "border-amber-500/30 text-amber-500",
          )}
        >
          <span className={cn("size-1.5 rounded-full", summaryTone === "ok" ? "bg-emerald-500" : summaryTone === "fail" ? "bg-rose-500" : summaryTone === "muted" ? "bg-muted-foreground/50" : "bg-amber-500")} />
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
        <PanelHeader title="Hosts" action={hasHosts ? <span className="text-[11.5px] tabular-nums text-muted-foreground">{hosts!.length} host{hosts!.length > 1 ? "s" : ""}</span> : undefined} />
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
          <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">No server? If this machine can handle it, install a local hypervisor and run VM labs here.</p>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("setup")}>Set up this machine</Button>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border bg-surface text-muted-foreground">
        <Server className="size-5" />
      </span>
      <p className="mt-4 text-[14px] font-medium">No server connected</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-muted-foreground">Add your Proxmox or ESXi server to run heavier, multi-VM labs on it instead of this machine.</p>
      <Button variant="learn" size="sm" className="mt-5" onClick={onAdd}><Plus className="size-3.5" /> Add host</Button>
    </div>
  );
}

function HostRow({
  host,
  isDefault,
  running,
  capacity,
  test,
  lastVm,
  now,
  vmTesting,
  onTest,
  onVmTest,
  onVmTestDone,
  onEdit,
  onDefault,
  onRemove,
}: {
  host: ServerHost;
  isDefault: boolean;
  running: number;
  capacity: HostCapacity | null | undefined;
  test: ServerTest | "testing" | undefined;
  lastVm: VmTest | undefined;
  now: number;
  vmTesting: boolean;
  onTest: () => void;
  onVmTest: () => void;
  onVmTestDone: (result: "ok" | "fail") => void;
  onEdit: () => void;
  onDefault: () => void;
  onRemove: () => void;
}) {
  const result = test && test !== "testing" ? test : null;
  const tone: Tone = test === "testing" || !test ? "muted" : result!.ok ? "ok" : "fail";
  const status = test === "testing" ? "Testing…" : !test ? "Not tested" : result!.ok ? "Online" : "Unreachable";
  const endpoint = `${KIND[host.provider].label} · ${host.username}@${host.host}:${host.port}${host.node ? ` · node ${host.node}` : ""}`;
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <TypeIcon><Server className="size-4" /></TypeIcon>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] font-medium">
            {host.name}
            <StatusPill tone={tone}>
              {status}
              {result?.latencyMs != null && <span className="ml-1 font-mono text-[10.5px] tabular-nums text-muted-foreground">{result.latencyMs} ms</span>}
            </StatusPill>
            <button
              type="button"
              onClick={onDefault}
              title={isDefault ? "The default host for website launches. Click to unset." : "Make this the default host for website launches."}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide transition-colors",
                isDefault ? "border-learn/50 bg-learn/10 text-learn" : "border-border text-muted-foreground/70 hover:border-ring/60 hover:text-foreground",
              )}
            >
              <Star className={cn("size-2.5", isDefault && "fill-current")} /> Default
            </button>
          </p>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">{endpoint}</p>
          {/* Capacity, running labs and the last VM test: only the ones we actually know. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {capacity && (
              <>
                <span className="inline-flex items-center gap-1"><Cpu className="size-3" /> {capacity.cores} vCPU</span>
                <span className="inline-flex items-center gap-1"><MemoryStick className="size-3" /> {fmtGb(capacity.memFree)} free of {fmtGb(capacity.memTotal)}</span>
              </>
            )}
            {running > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-learn">
                <span className="size-1.5 rounded-full bg-learn" /> {running} lab{running > 1 ? "s" : ""} running
              </span>
            )}
            {lastVm && (
              <span className={cn("inline-flex items-center gap-1", lastVm.result === "ok" ? "text-emerald-500" : "text-rose-500")}>
                {lastVm.result === "ok" ? <Check className="size-3" /> : <X className="size-3" />} VM test {lastVm.result === "ok" ? "passed" : "failed"} · {ago(lastVm.at, now)}
              </span>
            )}
          </p>
          {result && !result.ok && <p className="mt-1 text-[12px] text-rose-500">{result.message}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onTest} disabled={test === "testing"}>
            {test === "testing" ? "Testing…" : "Test"}
          </Button>
          <Menu
            items={[
              { label: vmTesting ? "Hide VM test" : "VM test", icon: FlaskConical, onClick: onVmTest },
              { label: "Edit", icon: Pencil, onClick: onEdit },
              { label: "Remove", icon: Trash2, danger: true, onClick: onRemove },
            ]}
          />
        </div>
      </div>
      {vmTesting && (
        <div className="px-3.5 pb-3.5">
          <ServerSelfTest id={host.id} provider={host.provider} onDone={onVmTestDone} />
        </div>
      )}
    </div>
  );
}

/** The step plan each provider reports, shown up front so the list doesn't grow as it runs. */
const SELFTEST_PLAN: Record<"proxmox" | "esxi", { step: string; label: string }[]> = {
  proxmox: [
    { step: "connect", label: "Reach the host" },
    { step: "prepare", label: "Prepare a test VM definition" },
    { step: "apply", label: "Create and boot the VM on the host" },
    { step: "boot", label: "VM reports a network address" },
    { step: "ssh", label: "SSH answers on the VM" },
    { step: "cleanup", label: "Destroy the test VM" },
  ],
  esxi: [
    { step: "connect", label: "Reach the host" },
    { step: "prepare", label: "Prepare a test VM definition" },
    { step: "up", label: "Create and boot the VM on the host" },
    { step: "ssh", label: "Run a command in the VM" },
    { step: "cleanup", label: "Destroy the test VM" },
  ],
};

/** Runs a real-VM self-test on a host and renders each step, like the machine VM test. It
 *  really provisions a throwaway VM on the server and destroys it, so it takes a few minutes. */
function ServerSelfTest({ id, provider, onDone }: { id: string; provider: ServerHost["provider"]; onDone: (result: "ok" | "fail") => void }) {
  const plan = SELFTEST_PLAN[provider === "proxmox" ? "proxmox" : "esxi"];
  const [states, setStates] = useState<Record<string, { state: string; detail?: string }>>({});
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const hadFail = useRef(false);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    let alive = true;
    serverSelftest(id, (e: SelfTestEvent) => {
      if (e.state === "fail") hadFail.current = true;
      if (alive) setStates((s) => ({ ...s, [e.step]: { state: e.state, detail: e.detail ?? undefined } }));
    })
      .catch((err) => {
        hadFail.current = true;
        if (alive) setError(String(err));
      })
      .finally(() => {
        if (alive) {
          setRunning(false);
          doneRef.current(hadFail.current ? "fail" : "ok");
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const failed = Object.values(states).some((s) => s.state === "fail") || !!error;
  const elapsed = Math.max(0, Math.floor((now - startAt) / 1000));
  const fmt = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11.5px] font-medium">{running ? "Running a real VM on the host…" : failed ? "VM test failed" : "VM test passed"}</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">{fmt}</span>
      </div>
      <div className="divide-y divide-border/60">
        {plan.map((p) => {
          const st = states[p.step]?.state ?? "idle";
          return (
            <div key={p.step} className="flex items-start gap-2.5 px-3 py-2">
              <span className="mt-0.5">
                {st === "ok" ? (
                  <Check className="size-3.5 text-emerald-500" />
                ) : st === "fail" ? (
                  <X className="size-3.5 text-rose-500" />
                ) : st === "running" ? (
                  <Spinner className="size-3.5 text-learn" />
                ) : (
                  <Circle className={cn("size-3.5", st === "skip" ? "text-muted-foreground/40" : "text-muted-foreground/30")} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[12.5px]", st === "idle" ? "text-muted-foreground/60" : "text-foreground")}>{p.label}</p>
                {states[p.step]?.detail && <p className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">{states[p.step]!.detail}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="border-t border-border px-3 py-2 text-[11.5px] text-rose-500">{error}</p>}
    </div>
  );
}

type MenuItem = { label: string; icon: typeof Pencil; onClick: () => void; danger?: boolean };
/** Overflow menu. The dropdown is positioned `fixed` from the trigger's rect so it escapes
 *  the Panel's `overflow-hidden` (an `absolute` child would be clipped). It closes on scroll
 *  or resize, since a fixed position would otherwise drift from the button. */
function Menu({ items }: { items: MenuItem[] }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="More actions"
        onClick={() => (pos ? setPos(null) : open())}
        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {pos && (
        <>
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setPos(null)} />
          <div style={{ position: "fixed", top: pos.top, right: pos.right }} className="z-50 w-36 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={() => {
                  setPos(null);
                  it.onClick();
                }}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted", it.danger ? "text-rose-500" : "text-foreground")}
              >
                <it.icon className="size-3.5" /> {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
