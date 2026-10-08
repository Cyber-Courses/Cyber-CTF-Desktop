"use client";

import { Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type CloudProvider } from "@/lib/tauri";
import { RadioList, RadioRow } from "@/components/ui/radio-row";
import { CLOUD_META, CLOUD_PICKER, KIND } from "@/features/servers/host-setup/constants";
import { MarkTile, Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function ProviderStep({ s }: { s: HostSetup }) {
  const { onDone, cloudProvider, pickProvider, next } = s;
  return (
    <Step
      icon={Cloud}
      title="Choose a cloud provider"
      description="Where labs run as throwaway instances in your own account. AWS, Azure and Google Cloud; more coming."
    >
      <RadioList label="Cloud provider">
        {CLOUD_PICKER.map((p) => (
          <RadioRow
            key={p.id}
            selected={p.ready && cloudProvider === p.id}
            onSelect={() => pickProvider(p.id as CloudProvider)}
            disabled={!p.ready}
            hint={p.ready ? undefined : "Coming soon"}
            leading={
              <MarkTile>
                {p.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
                  <img src={`/brands/${p.id}.svg`} alt="" className="size-5 object-contain" draggable={false} />
                ) : (
                  <Cloud className="size-4" />
                )}
              </MarkTile>
            }
            title={p.label}
            subtitle={p.ready ? (KIND[p.id as CloudProvider]?.note ?? "Available") : "Coming soon"}
          />
        ))}
      </RadioList>
      <Nav
        left={
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        }
        right={
          <Button onClick={next} disabled={!CLOUD_META[cloudProvider]?.ready}>
            Continue
          </Button>
        }
      />
    </Step>
  );
}
