"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { type Provider, type ProviderStatus, type SystemReport } from "@/lib/tauri";
import { getVmProvider, setVmProvider } from "@/lib/settings";
import { providerLabel } from "@/features/machine/hypervisors";
import { Row } from "@/features/settings/settings-layout";
import { Segmented } from "@/components/ui/segmented";

export function HypervisorRow({ report, onSaved, onNavigate }: { report: SystemReport | null; onSaved: () => void; onNavigate: (tab: "machine") => void }) {
  const [provider, setProvider] = useState<Provider | null>(() => getVmProvider());
  // Local hypervisors VM labs can start on right now (hypervisor + Vagrant plugin ready).
  const ready: ProviderStatus[] | null = report ? report.vmProviders.filter((p) => !p.remote && p.available && p.hypervisor !== false) : null;
  // A saved choice that's no longer installed falls back to automatic.
  const effective = ready?.some((h) => h.provider === provider) ? provider : null;

  function choose(p: Provider | null) {
    setVmProvider(p);
    setProvider(p);
    onSaved();
  }

  const setupLink = (
    <button onClick={() => onNavigate("machine")} className="inline-flex items-center gap-1 text-link underline-offset-4 hover:underline">
      Set one up on the Machine page <ArrowRight className="size-3" />
    </button>
  );

  if (ready === null) {
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

  if (ready.length === 0) {
    return <Row title="Hypervisor for VM labs" description={<>No hypervisor is ready on this machine yet. {setupLink}</>} />;
  }

  const options: (Provider | null)[] = ready.length > 1 ? [null, ...ready.map((h) => h.provider)] : [];

  return (
    <Row
      title="Hypervisor for VM labs"
      description={
        ready.length === 1 ? (
          <>VM labs run on {providerLabel(ready[0])}, the only hypervisor ready here.</>
        ) : effective === null ? (
          <>Automatic picks {providerLabel(ready[0])}, the first ready hypervisor.</>
        ) : (
          <>VM labs and the VM test run on {providerLabel(ready.find((h) => h.provider === effective)!)}.</>
        )
      }
      control={
        ready.length === 1 ? (
          <Badge variant="success" dot>
            {providerLabel(ready[0])}
          </Badge>
        ) : (
          <Segmented
            label="Hypervisor"
            value={effective}
            onChange={choose}
            options={options.map((p) => {
              const status = ready.find((h) => h.provider === p);
              return { value: p, label: p === null ? "Automatic" : status ? providerLabel(status) : p };
            })}
          />
        )
      }
    />
  );
}
