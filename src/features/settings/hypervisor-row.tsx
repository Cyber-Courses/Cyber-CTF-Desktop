"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogConsole } from "@/components/ui/log-console";
import { RadioList, RadioRow } from "@/components/ui/radio-row";
import { Spinner } from "@/components/ui/spinner";
import { HypervisorLogo } from "@/features/machine/hypervisor-logo";
import { providerLabel } from "@/features/machine/hypervisors";
import { Row } from "@/features/settings/settings-layout";
import { getVmProvider, setVmProvider } from "@/lib/settings";
import { installVagrantPlugin, type Provider, type ProviderStatus, type SystemReport } from "@/lib/tauri";

/**
 * Which local hypervisor VM labs run on. Every installed one is listed: the ready ones can be
 * picked (or Automatic, the first ready one); one that's installed but missing its Vagrant
 * add-on says so and offers to install it, then becomes pickable.
 */
export function HypervisorRow({
  report,
  onSaved,
  onNavigate,
  onRefresh,
}: {
  report: SystemReport | null;
  onSaved: () => void;
  onNavigate: (tab: "machine") => void;
  onRefresh: () => void;
}) {
  const [provider, setProvider] = useState<Provider | null>(() => getVmProvider());
  const [installing, setInstalling] = useState<string | null>(null);
  const [log, setLog] = useState<string[] | null>(null);

  const local = report ? report.vmProviders.filter((p) => !p.remote && p.hypervisor === true) : null;
  // Ready = hypervisor + Vagrant + its plugin: VM labs can start on it right now.
  const ready: ProviderStatus[] = (local ?? []).filter((p) => p.available);
  const notReady: ProviderStatus[] = (local ?? []).filter((p) => !p.available);
  // A saved choice that's no longer ready falls back to automatic.
  const effective = ready.some((h) => h.provider === provider) ? provider : null;

  function choose(p: Provider | null) {
    setVmProvider(p);
    setProvider(p);
    onSaved();
  }

  async function installAddon(plugin: string) {
    setInstalling(plugin);
    setLog([`Installing the Vagrant add-on ${plugin}…`]);
    try {
      await installVagrantPlugin(plugin, (l) => setLog((x) => [...(x ?? []), l]));
      setLog((x) => [...(x ?? []), "✓ Installed"]);
    } catch (e) {
      setLog((x) => [...(x ?? []), `✗ ${String(e)}`]);
    } finally {
      setInstalling(null);
      onRefresh();
    }
  }

  const setupLink = (
    <button onClick={() => onNavigate("machine")} className="inline-flex items-center gap-1 text-link underline-offset-4 hover:underline">
      Set one up on the Machine page <ArrowRight className="size-3" />
    </button>
  );

  if (local === null) {
    return (
      <Row
        title="Hypervisor for VM labs"
        description={
          <span className="flex items-center gap-2">
            <Spinner className="size-3" /> Checking hypervisors…
          </span>
        }
      />
    );
  }
  if (local.length === 0) {
    return <Row title="Hypervisor for VM labs" description={<>No hypervisor is installed on this machine yet. {setupLink}</>} />;
  }

  const current = ready.find((h) => h.provider === (effective ?? ready[0]?.provider));
  return (
    <Row
      stacked
      title="Hypervisor for VM labs"
      description={
        current ? (
          <>VM labs and the VM test run on {providerLabel(current)}.</>
        ) : (
          <>None of the installed hypervisors can run VM labs yet. Install its Vagrant add-on below.</>
        )
      }
    >
      {ready.length > 0 && (
        <RadioList label="Hypervisor for VM labs" className="mt-3">
          {ready.length > 1 && (
            <RadioRow
              selected={effective === null}
              onSelect={() => choose(null)}
              title="Automatic"
              subtitle={`Uses ${providerLabel(ready[0])}, the first ready hypervisor.`}
            />
          )}
          {ready.map((h) => (
            <RadioRow
              key={h.provider}
              selected={effective === h.provider || (ready.length === 1 && effective === null)}
              onSelect={() => choose(h.provider)}
              title={
                <span className="flex items-center gap-2">
                  <HypervisorLogo provider={h.provider} size="sm" />
                  {providerLabel(h)}
                </span>
              }
              subtitle={h.plugin ? `Ready · Vagrant add-on ${h.plugin}` : "Ready · built into Vagrant"}
            />
          ))}
        </RadioList>
      )}
      {notReady.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          {notReady.map((h) => (
            <div key={h.provider} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
              <HypervisorLogo provider={h.provider} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-[0.8125rem] font-medium text-foreground">{providerLabel(h)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {h.plugin && !h.pluginInstalled ? `Installed · needs the Vagrant add-on ${h.plugin}` : (h.reason ?? "Installed · not ready for VM labs")}
                </p>
              </div>
              {h.plugin && !h.pluginInstalled && (
                <Button variant="outline" size="sm" disabled={installing !== null || !report?.vagrant.installed} onClick={() => installAddon(h.plugin!)}>
                  {installing === h.plugin ? (
                    <>
                      <Spinner className="size-3.5" /> Installing…
                    </>
                  ) : (
                    "Install add-on"
                  )}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {log && <LogConsole lines={log} running={installing !== null} title="Vagrant add-on" />}
    </Row>
  );
}
