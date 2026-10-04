"use client";

import { ArrowLeft, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KIND } from "@/features/servers/host-setup/constants";
import { Field, Input, Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function ConnectionStep({ s }: { s: HostSetup }) {
  const { v, editing, kind, set, text, connectionOk, next, back } = s;
  return (
    <Step
      icon={Network}
      title={`Connect to ${KIND[v.provider].label}`}
      description={v.provider === "proxmox" ? "The launcher signs in to the Proxmox API." : "The launcher drives the host over SSH."}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6.875rem]">
        <Field label="Name">
          <Input {...text("name")} placeholder={v.provider === "proxmox" ? "Garage Proxmox" : "ESXi box"} />
        </Field>
        <Field label="Host">
          <Input {...text("host")} placeholder="192.168.1.20 or pve.lan" />
        </Field>
        <Field label={v.provider === "proxmox" ? "API port" : "SSH port"}>
          <Input
            type="number"
            min={1}
            max={65535}
            value={v.port ?? ""}
            onChange={(e) => set("port", e.target.value ? Number(e.target.value) : null)}
            placeholder={String(kind.port)}
          />
        </Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Username" hint={v.provider === "proxmox" ? "With realm, e.g. root@pam" : undefined}>
          <Input {...text("username")} placeholder={kind.user} />
        </Field>
        <Field label="Password" hint="Stored in your OS keychain">
          <Input
            type="password"
            value={v.password ?? ""}
            onChange={(e) => set("password", e.target.value || null)}
            placeholder={editing ? "Unchanged" : ""}
            autoComplete="off"
          />
        </Field>
      </div>
      <Nav
        left={
          <Button variant="outline" onClick={back}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        }
        right={
          <Button variant="learn" onClick={next} disabled={!connectionOk}>
            Continue
          </Button>
        }
      />
    </Step>
  );
}
