"use client";

/** The Cloud page: connect a cloud account (AWS, Azure or GCP) and run labs as throwaway
 *  instances in it. Kept separate from the Server page so each evolves on its own. */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus, Square } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Meter } from "@/components/ui/meter";
import { StatusDot, StatusPill } from "@/components/ui/status-pill";
import { Spinner } from "@/components/ui/spinner";
import { useLabs, type Lab } from "@/features/labs/use-labs";
import {
  awsMonthToDateCost,
  SERVER_CHANGED,
  serverList,
  serverOpenSetup,
  serverRemove,
  serverTest,
  type CloudProvider,
  type ServerHost,
  type ServerTest,
} from "@/lib/tauri";
import { AccountRow, LogoTile } from "@/features/cloud/account-row";
import { FirstRun } from "@/features/cloud/first-run";
import { ignore } from "@/lib/failure";
import { useLabActions } from "@/features/labs/use-lab-actions";
import { getDeploySnapshot } from "@/lib/deploy-store";
import { useFormat, useT } from "@/lib/i18n";

const MAIN_PROVIDERS: { id: CloudProvider; label: string }[] = [
  { id: "aws", label: "Amazon Web Services" },
  { id: "azure", label: "Microsoft Azure" },
  { id: "gcp", label: "Google Cloud" },
];

export function CloudScreen() {
  const t = useT();
  const format = useFormat();
  const usd = (n: number) => format.number(n, { style: "currency", currency: "USD" });
  const [allHosts, setHosts] = useState<ServerHost[] | null>(null);
  const hosts =
    allHosts?.filter(
      (h) =>
        h.provider === "aws" ||
        h.provider === "azure" ||
        h.provider === "gcp" ||
        h.provider === "digitalocean" ||
        h.provider === "linode" ||
        h.provider === "oci",
    ) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ServerTest | "testing">>({});
  const [spend, setSpend] = useState<Record<string, number | null>>({});
  const { labs, statuses, refreshStatus } = useLabs();
  // Through the shared lab actions: the lab reads busy everywhere (this list, Labs, its page)
  // until its status after the stop is read, so Stop can't be pressed twice.
  const { runs, stop } = useLabActions(refreshStatus);

  const reload = useCallback(() => {
    serverList()
      .then((l) => {
        setHosts(l.hosts);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);
  // The setup window saves accounts; refresh when it says so.
  useEffect(() => {
    const off = listen(SERVER_CHANGED, reload);
    return () => {
      off.then((f) => f()).catch(ignore("the listener never got set up"));
    };
  }, [reload]);
  // Month-to-date spend, only for accounts that set a budget (Cost Explorer costs per call).
  useEffect(() => {
    (allHosts ?? [])
      .filter((h) => h.provider === "aws" && h.monthlyLimit)
      .forEach((h) => {
        awsMonthToDateCost(h.awsProfile ?? undefined)
          .then((c) => setSpend((s) => ({ ...s, [h.id]: c })))
          .catch(ignore("the spend is shown only when it can be read"));
      });
  }, [allHosts]);

  const openSetup = (id?: string) => serverOpenSetup(id ?? null, "cloud").catch((e) => setError(String(e)));

  const test = useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const r = await serverTest(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e), checks: [] } }));
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
    await stop(l);
    // A failure ends the run's log with "✗ <why>": show it here too.
    const last = getDeploySnapshot().runs[l.id]?.logs.at(-1);
    if (last?.startsWith("✗")) setError(last.slice(1).trim());
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

  // Budget guard: AWS accounts that set a monthly budget.
  const budgeted = (hosts ?? []).filter((h) => h.provider === "aws" && h.monthlyLimit != null);
  const month = format.date(new Date(), { month: "long" });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("cloud.screen.title")}
        lead={t("cloud.screen.lead")}
        actions={
          hosts && hosts.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => openSetup()}>
              <Plus className="size-3.5" /> {t("cloud.screen.setUp")}
            </Button>
          ) : undefined
        }
      />

      {error && <Callout tone="fail">{error}</Callout>}

      {over.length > 0 && (
        <Callout tone="fail">
          {over.length === 1 ? t("cloud.screen.overOne", { name: over[0].name }) : t("cloud.screen.overMany", { count: over.length })}
        </Callout>
      )}

      {running.length > 0 && (
        <Panel>
          <PanelHeader title={t("cloud.screen.runningNow")} meta={t("cloud.screen.billingWhileRunning")} />
          {running.map((l) => {
            const s = statuses[l.id];
            return (
              <div
                key={l.id}
                className="flex min-h-[3.25rem] items-center gap-3 border-t border-border px-4 py-2 transition-colors first:border-t-0 hover:bg-glass"
              >
                <StatusDot tone="ok" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8125rem] font-medium">{l.title}</p>
                  <p className="truncate font-mono text-[0.6875rem] text-faint">
                    {s?.host}
                    {s?.expiresAt ? ` · ${t("cloud.screen.autoStops", { time: format.date(s.expiresAt * 1000, { hour: "2-digit", minute: "2-digit" }) })}` : ""}
                  </p>
                </div>
                <Button variant="destructive" size="xs" onClick={() => void stopLab(l)} disabled={!!runs[l.id]?.busy}>
                  {runs[l.id]?.busy ? <Spinner className="size-3" /> : <Square className="size-3" />} {t("cloud.screen.stop")}
                </Button>
              </div>
            );
          })}
        </Panel>
      )}

      {hosts === null ? (
        <Panel>
          <div className="flex items-center gap-2 px-4 py-4 text-[0.8125rem] text-muted-foreground">
            <Spinner className="size-4" /> {t("cloud.screen.loading")}
          </div>
        </Panel>
      ) : hosts.length === 0 ? (
        <FirstRun onSetup={() => openSetup()} />
      ) : (
        <Panel>
          <PanelHeader title={t("cloud.screen.accounts")} meta={t("cloud.screen.billedOnly")} />
          {hosts.map((h) => (
            <AccountRow
              key={h.id}
              host={h}
              test={tests[h.id]}
              spent={spend[h.id]}
              onTest={() => test(h.id)}
              onEdit={() => openSetup(h.id)}
              onRemove={() => remove(h.id)}
            />
          ))}
          {/* The main providers not connected yet, one click from their setup. */}
          {MAIN_PROVIDERS.filter((p) => !hosts.some((h) => h.provider === p.id)).map((p) => (
            <div
              key={p.id}
              className="grid min-h-[3.25rem] grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-border px-4 py-2.5 transition-colors hover:bg-glass"
            >
              <LogoTile provider={p.id} />
              <div className="min-w-0">
                <p className="truncate text-[0.8125rem] font-medium text-foreground">{p.label}</p>
                <p className="truncate font-mono text-[0.6875rem] text-faint">{t("cloud.screen.notConnected")}</p>
              </div>
              <Button variant="outline" size="xs" onClick={() => openSetup()}>
                {t("cloud.screen.connect")}
              </Button>
            </div>
          ))}
        </Panel>
      )}

      {budgeted.map((h) => {
        const spent = spend[h.id];
        const limit = h.monthlyLimit!;
        const isOver = spent != null && spent >= limit;
        return (
          <Panel key={h.id}>
            <PanelHeader title={t("cloud.screen.budgetGuard", { name: h.name })} meta={month} />
            <div className="grid gap-3 px-4 pt-4 pb-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="serif-title text-[1.75rem] leading-none text-foreground">
                  {spent != null ? usd(spent) : "$…"}{" "}
                  <small className="font-sans text-[0.8125rem] tracking-normal text-faint">{t("cloud.screen.ofLimit", { limit: usd(limit) })}</small>
                </span>
                <span className="flex items-center gap-2 font-mono text-[0.6875rem] text-faint">
                  {isOver && <StatusPill tone="fail">{t("cloud.screen.overBudget")}</StatusPill>}
                  {h.autoStopHours ? t("cloud.screen.autoStopAfter", { hours: h.autoStopHours }) : t("cloud.screen.noAutoStop")}
                </span>
              </div>
              <Meter value={spent != null && limit > 0 ? (spent / limit) * 100 : 0} />
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

/** A compact warning or error row: a status dot, then the message in muted ink. */
function Callout({ tone, children }: { tone: "warn" | "fail"; children: ReactNode }) {
  return (
    <Panel>
      <div className="flex items-start gap-3 px-4 py-3 text-[0.8125rem]">
        <StatusDot tone={tone} className="mt-1.5" />
        <p className="min-w-0 break-words text-muted-foreground">{children}</p>
      </div>
    </Panel>
  );
}
