"use client";

/** The Cloud page: connect a cloud account (AWS today) and run labs as throwaway instances
 *  in it. Kept separate from the Server page so each evolves on its own. */

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Cloud, Plus, Square } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLabs, type Lab } from "@/features/labs/use-labs";
import {
  awsMonthToDateCost,
  installDependency,
  labStop,
  provisioningImages,
  provisioningPull,
  SERVER_CHANGED,
  serverList,
  serverOpenSetup,
  serverRemove,
  serverTest,
  systemCheck,
  type Dependency,
  type ProvisioningImage,
  type ServerHost,
  type ServerTest,
  type SystemReport,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { AccountRow } from "@/features/cloud/account-row";
import { COMING_SOON, FirstRun } from "@/features/cloud/first-run";
import { CliRow, ImageRow, ToolRow } from "@/features/cloud/tool-rows";

export function CloudScreen() {
  const [allHosts, setHosts] = useState<ServerHost[] | null>(null);
  const hosts = allHosts?.filter((h) => h.provider === "aws" || h.provider === "azure" || h.provider === "gcp") ?? null;
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ServerTest | "testing">>({});
  const [report, setReport] = useState<SystemReport | null>(null);
  const [provImages, setProvImages] = useState<ProvisioningImage[] | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [pullBusy, setPullBusy] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState<boolean | null>(null);
  const [spend, setSpend] = useState<Record<string, number | null>>({});
  const { labs, statuses, refreshStatus } = useLabs();
  const [stopping, setStopping] = useState<string | null>(null);

  const reload = useCallback(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    systemCheck()
      .then(setReport)
      .catch(() => {});
    provisioningImages()
      .then(setProvImages)
      .catch(() => {});
  }, []);
  // The setup window saves accounts; refresh when it says so.
  useEffect(() => {
    const off = listen(SERVER_CHANGED, reload);
    return () => {
      off.then((f) => f()).catch(() => {});
    };
  }, [reload]);
  // Month-to-date spend, only for accounts that set a budget (Cost Explorer costs per call).
  useEffect(() => {
    (allHosts ?? [])
      .filter((h) => h.provider === "aws" && h.monthlyLimit)
      .forEach((h) => {
        awsMonthToDateCost(h.awsProfile ?? undefined)
          .then((c) => setSpend((s) => ({ ...s, [h.id]: c })))
          .catch(() => {});
      });
  }, [allHosts]);

  const openSetup = (id?: string) => serverOpenSetup(id ?? null, "cloud").catch((e) => setError(String(e)));

  const test = useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const r = await serverTest(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) } }));
    }
  }, []);

  async function remove(id: string) {
    try {
      await serverRemove(id);
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function stopLab(l: Lab) {
    if (!l.runtime) return;
    setStopping(l.id);
    try {
      await labStop(l.id, l.runtime.runtime, () => {});
      refreshStatus(l);
    } catch (e) {
      setError(String(e));
    } finally {
      setStopping(null);
    }
  }

  async function installCli(dep: Dependency) {
    setCliBusy(dep);
    try {
      await installDependency(dep, () => {});
      setReport(await systemCheck());
    } catch (e) {
      setError(String(e));
    } finally {
      setCliBusy(null);
    }
  }

  async function pull(image: string) {
    setPullBusy(image);
    setError(null);
    try {
      await provisioningPull(image, () => {});
      setProvImages(await provisioningImages());
    } catch (e) {
      setError(String(e));
    } finally {
      setPullBusy(null);
    }
  }

  const over = (hosts ?? []).filter((h) => {
    const s = spend[h.id];
    return h.monthlyLimit != null && s != null && s >= h.monthlyLimit;
  });
  // Labs running on one of these cloud accounts right now (status.host is the account name).
  const accountNames = new Set((hosts ?? []).map((h) => h.name));
  const running = (labs ?? []).filter((l) => {
    const s = statuses[l.id];
    return l.runtime && s?.running && !!s.host && accountNames.has(s.host);
  });
  const envReady = !!report?.cloudClis.aws.installed && !!report?.terraform.installed;
  // Only one install/pull/sign-in at a time: brew (and others) can't run two at once.
  const busyOp = cliBusy !== null || pullBusy !== null;
  const envExpanded = envOpen ?? !envReady;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">Cloud</h1>
        <Button variant="learn" size="sm" onClick={() => openSetup()}>
          <Plus className="size-3.5" /> Set up cloud provider
        </Button>
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[0.78125rem] text-destructive">{error}</p>}

      {over.length > 0 && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[0.78125rem] text-rose-300">
          {over.length === 1 ? `${over[0].name} is over its monthly budget` : `${over.length} accounts are over their monthly budget`} — new labs there are
          blocked until you raise the budget or next month.
        </p>
      )}

      {running.length > 0 && (
        <Panel>
          <PanelHeader title="Running now" action={<span className="text-[0.71875rem] text-muted-foreground">Billing while they run</span>} />
          {running.map((l) => {
            const s = statuses[l.id];
            return (
              <div key={l.id} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 text-[0.78125rem] last:border-b-0">
                <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{l.title}</p>
                  <p className="truncate text-[0.6875rem] text-muted-foreground">
                    {s?.host}
                    {s?.expiresAt ? ` · auto-stops ${new Date(s.expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => stopLab(l)} disabled={stopping === l.id}>
                  {stopping === l.id ? <Spinner className="size-3.5" /> : <Square className="size-3.5" />} Stop
                </Button>
              </div>
            );
          })}
        </Panel>
      )}

      <Panel>
        <PanelHeader
          title="Accounts"
          action={
            hosts && hosts.length > 0 ? (
              <span className="text-[0.71875rem] text-muted-foreground">Billed only while a lab runs; idle accounts cost nothing</span>
            ) : undefined
          }
        />
        {hosts === null ? (
          <div className="flex items-center gap-2 px-3.5 py-4 text-[0.78125rem] text-muted-foreground">
            <Spinner className="size-4" /> Loading…
          </div>
        ) : hosts.length === 0 ? (
          <FirstRun onSetup={() => openSetup()} />
        ) : (
          hosts.map((h) => (
            <AccountRow
              key={h.id}
              host={h}
              test={tests[h.id]}
              spent={spend[h.id]}
              onTest={() => test(h.id)}
              onEdit={() => openSetup(h.id)}
              onRemove={() => remove(h.id)}
            />
          ))
        )}
      </Panel>

      <Panel>
        <button type="button" onClick={() => setEnvOpen(!envExpanded)} className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left">
          <span className="text-[0.8125rem] font-semibold tracking-tight">Environment</span>
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
              envReady ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500",
            )}
          >
            <span className={cn("size-1.5 rounded-full", envReady ? "bg-emerald-500" : "bg-amber-500")} />
            {envReady ? "Ready" : "Setup needed"}
          </span>
          <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", envExpanded && "rotate-180")} />
        </button>
        {envExpanded && (
          <div className="border-t border-border">
            <CliRow
              name="AWS CLI"
              provider="aws"
              tool={report?.cloudClis.aws}
              busy={cliBusy === "awscli"}
              locked={busyOp}
              onInstall={() => installCli("awscli")}
            />
            <ToolRow
              name="Terraform"
              note="runs locally; simpler state (Docker image is the fallback)"
              tool={report?.terraform}
              busy={cliBusy === "terraform"}
              locked={busyOp}
              onInstall={() => installCli("terraform")}
            />
            {provImages?.map((img) => (
              <ImageRow
                key={img.image}
                image={img}
                note="runs in Docker (best on Windows)"
                busy={pullBusy === img.image}
                locked={busyOp}
                onPull={() => pull(img.image)}
              />
            ))}
            <div className="border-t border-border px-3.5 py-2.5">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/70">More providers · coming soon</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {COMING_SOON.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[0.6875rem] text-muted-foreground"
                  >
                    {p.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
                      <img src={`/brands/${p.id}.svg`} alt="" className="size-3.5" draggable={false} />
                    ) : (
                      <Cloud className="size-3.5" />
                    )}
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
