"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Check, Copy, KeyRound, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KIND } from "@/features/servers/host-setup/constants";
import { Field, Input, Nav, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";
import { serverPublicKey } from "@/lib/tauri/servers";

export function ConnectionStep({ s }: { s: HostSetup }) {
  const { v, editing, kind, set, text, connectionOk, next, back } = s;
  // Proxmox accepts an API token id (user@realm!name) in the username field; in that mode the
  // "password" is the token secret and SSH uses the launcher's key, which must be authorized
  // on the node, so we show it.
  const isToken = v.provider === "proxmox" && (v.username ?? "").includes("!");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (isToken && pubkey === null) serverPublicKey().then(setPubkey).catch(() => {});
  }, [isToken, pubkey]);
  const copyKey = async () => {
    if (!pubkey) return;
    try {
      await navigator.clipboard.writeText(pubkey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the key is shown for manual copy */
    }
  };
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
        <Field label="Username" hint={v.provider === "proxmox" ? "root@pam, or an API token id like root@pam!name" : undefined}>
          <Input {...text("username")} placeholder={kind.user} />
        </Field>
        <Field label={isToken ? "Token secret" : "Password"} hint="Stored in your OS keychain">
          <Input
            type="password"
            value={v.password ?? ""}
            onChange={(e) => set("password", e.target.value || null)}
            placeholder={editing ? "Unchanged" : ""}
            autoComplete="off"
          />
        </Field>
      </div>
      {isToken && (
        <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[0.75rem] font-medium">
            <KeyRound className="size-3.5 text-muted-foreground" /> Authorize the launcher&apos;s SSH key
          </div>
          <p className="mt-1 text-[0.6875rem] text-muted-foreground">
            Token hosts use this key over SSH to upload the cloud-init snippet. Add it to the token user&apos;s
            <code className="mx-1 rounded bg-muted px-1 py-0.5">~/.ssh/authorized_keys</code> on the Proxmox node.
          </p>
          <div className="mt-2 flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-[0.6875rem] text-muted-foreground">
              {pubkey ?? "Loading the launcher's public key…"}
            </code>
            <Button variant="outline" size="sm" onClick={copyKey} disabled={!pubkey}>
              {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
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
