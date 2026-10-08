"use client";

import { CheckCircle2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { KIND, SERVER_KINDS } from "@/features/servers/host-setup/constants";
import { HypervisorMark, Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function HypervisorStep({ s }: { s: HostSetup }) {
  const { v, setV, next } = s;
  return (
    <Step icon={Server} title="Choose your hypervisor" description="Where the launcher will create and run VM labs.">
      <div className="grid grid-cols-2 gap-2.5">
        {SERVER_KINDS.map((p) => {
          const selected = v.provider === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => setV((s) => ({ ...s, provider: p, port: null }))}
              className={cn(
                "relative rounded-panel border p-4 text-left transition-colors",
                selected ? "border-jewel bg-jewel/5 ring-1 ring-jewel/40" : "border-border hover:border-ring/60",
              )}
            >
              <span
                className={cn(
                  "absolute right-3 top-3 grid size-4 place-items-center rounded-full border transition-colors",
                  selected ? "border-jewel bg-jewel-solid text-jewel-on" : "border-muted-foreground/30",
                )}
              >
                {selected && <CheckCircle2 className="size-3" />}
              </span>
              <HypervisorMark provider={p} />
              <p className="mt-2 text-[0.71875rem] text-muted-foreground">{KIND[p].note}</p>
            </button>
          );
        })}
      </div>
      <Nav
        right={
          <Button variant="primary" onClick={next}>
            Continue
          </Button>
        }
      />
    </Step>
  );
}
