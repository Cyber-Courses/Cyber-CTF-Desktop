"use client";

import { CheckCircle2, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type CloudProvider } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { CLOUD_META, CLOUD_PICKER } from "@/features/servers/host-setup/constants";
import { Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function ProviderStep({ s }: { s: HostSetup }) {
  const { onDone, cloudProvider, pickProvider, next } = s;
  return (
    <Step
      icon={Cloud}
      title="Choose a cloud provider"
      description="Where labs run as throwaway instances in your own account. AWS, Azure and Google Cloud; more coming."
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {CLOUD_PICKER.map((p) => {
          const selected = p.ready && cloudProvider === p.id;
          return (
            <button
              key={p.id}
              type="button"
              disabled={!p.ready}
              onClick={() => p.ready && pickProvider(p.id as CloudProvider)}
              className={cn(
                "relative rounded-xl border p-4 text-left transition-colors",
                !p.ready
                  ? "cursor-default border-border opacity-55"
                  : selected
                    ? "border-learn bg-learn/5 ring-1 ring-learn/40"
                    : "border-border hover:border-ring/60",
              )}
            >
              {p.ready && (
                <span
                  className={cn(
                    "absolute right-3 top-3 grid size-4 place-items-center rounded-full border transition-colors",
                    selected ? "border-learn bg-learn text-white" : "border-muted-foreground/30",
                  )}
                >
                  {selected && <CheckCircle2 className="size-3" />}
                </span>
              )}
              {p.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- static export, plain asset
                <img src={`/brands/${p.id}.svg`} alt="" className="size-6" draggable={false} />
              ) : (
                <Cloud className="size-6 text-muted-foreground" />
              )}
              <p className="mt-2 text-[0.78125rem] font-medium">{p.label}</p>
              <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{p.ready ? "Available" : "Coming soon"}</p>
            </button>
          );
        })}
      </div>
      <Nav
        left={
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        }
        right={
          <Button variant="learn" onClick={next} disabled={!CLOUD_META[cloudProvider]?.ready}>
            Continue
          </Button>
        }
      />
    </Step>
  );
}
