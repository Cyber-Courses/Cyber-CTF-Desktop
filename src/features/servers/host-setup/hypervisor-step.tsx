"use client";

import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioList, RadioRow } from "@/components/ui/radio-row";
import { KIND, SERVER_KINDS } from "@/features/servers/host-setup/constants";
import { HypervisorMark, MarkTile, Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function HypervisorStep({ s }: { s: HostSetup }) {
  const { v, setV, next } = s;
  return (
    <Step icon={Server} title="Choose your hypervisor" description="Where the launcher will create and run VM labs.">
      <RadioList label="Hypervisor">
        {SERVER_KINDS.map((p) => (
          <RadioRow
            key={p}
            selected={v.provider === p}
            onSelect={() => setV((s) => ({ ...s, provider: p, port: null }))}
            leading={
              <MarkTile>
                <HypervisorMark provider={p} />
              </MarkTile>
            }
            title={KIND[p].label}
            subtitle={KIND[p].note}
          />
        ))}
      </RadioList>
      <Nav right={<Button onClick={next}>Continue</Button>} />
    </Step>
  );
}
