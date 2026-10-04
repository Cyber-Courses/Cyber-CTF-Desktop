"use client";

import { ArrowLeft, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Field, Input, Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function PlacementStep({ s }: { s: HostSetup }) {
  const { v, saving, error, set, text, back, saveAndTest } = s;
  return (
    <Step icon={HardDrive} title="Placement" description="Where labs are placed on the host. Leave blank for the host's defaults.">
      <div className={cn("grid gap-3", v.provider === "proxmox" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {v.provider === "proxmox" && (
          <Field label="Node" hint="Optional">
            <Input {...text("node")} placeholder="pve" />
          </Field>
        )}
        <Field label={v.provider === "proxmox" ? "Storage" : "Datastore"} hint="Optional">
          <Input {...text("datastore")} placeholder={v.provider === "proxmox" ? "local-lvm" : "datastore1"} />
        </Field>
        <Field label={v.provider === "proxmox" ? "Bridge" : "Port group"} hint="Optional">
          <Input {...text("network")} placeholder={v.provider === "proxmox" ? "vmbr0" : "VM Network"} />
        </Field>
      </div>
      {v.provider === "proxmox" && (
        <label className="mt-4 flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={v.insecureTls}
            onChange={(e) => set("insecureTls", e.target.checked)}
            className="mt-0.5 size-3.5 accent-[var(--learn)]"
          />
          <span>
            <span className="block text-[0.78125rem]">Self-signed certificate</span>
            <span className="block text-[0.71875rem] text-muted-foreground">Proxmox uses one by default. Turn off if your host has a trusted certificate.</span>
          </span>
        </label>
      )}
      {error && <p className="mt-3 text-[0.75rem] text-destructive">{error}</p>}
      <Nav
        left={
          <Button variant="outline" onClick={back}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        }
        right={
          <Button variant="learn" onClick={saveAndTest} disabled={saving}>
            {saving && <Spinner className="size-4" />} Save and test
          </Button>
        }
      />
    </Step>
  );
}
