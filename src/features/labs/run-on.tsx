"use client";

import { useEffect, useRef, useState } from "react";
import { serverTest, type Provider, type ServerHost, type ServerTest } from "@/lib/tauri";
import { RadioList, RadioRow } from "@/components/ui/radio-row";
import { StatusPill, type Tone } from "@/components/ui/status-pill";
import { TypeIcon } from "@/components/ui/type-icon";
import { KIND } from "@/features/servers/host-setup/constants";
import { ProviderGlyph } from "@/features/servers/provider-glyph";
import { HypervisorLogo } from "@/features/machine/hypervisor-logo";
import { PROVIDER_LABELS } from "@/features/machine/hypervisors";

export const CLOUDS = new Set(["aws", "azure", "gcp", "digitalocean", "linode", "oci"]);

/** Where a lab starts: this machine (Docker, or a VM on a local hypervisor) or a saved host. */
export type RunTarget = { kind: "local" } | { kind: "local-vm"; provider: Provider } | { kind: "host"; id: string } | { kind: "hosted" };

export const targetKey = (t: RunTarget) => (t.kind === "local" || t.kind === "hosted" ? t.kind : t.kind === "local-vm" ? `vm:${t.provider}` : `host:${t.id}`);

/**
 * A centered dialog over the page (Escape or a click on the backdrop closes it). The body
 * scrolls; `footer` (the actions) stays pinned at the bottom.
 */
export function RunOnDialog({ onClose, children, footer }: { onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Where should the lab run?"
        className="flex max-h-[85vh] w-full max-w-[28rem] flex-col rounded-xl border border-border bg-card shadow-2xl shadow-black/50 outline-none"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

type Status = { tone: Tone; label: string; title?: string };
type Option = { target: RunTarget; title: string; subtitle: string; ok: boolean; why?: string; logo: React.ReactNode; status?: Status };

/** Each host's connection test, run once when the picker opens (like "Test" on the Servers page). */
function useHostChecks(hosts: ServerHost[]) {
  const [checks, setChecks] = useState<Record<string, ServerTest | "testing">>({});
  const ids = hosts.map((h) => h.id).join(",");
  useEffect(() => {
    let live = true;
    const list = ids ? ids.split(",") : [];
    // Marks every host "testing" before the async checks settle (one batch, not a cascade).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChecks(Object.fromEntries(list.map((id) => [id, "testing" as const])));
    for (const id of list) {
      serverTest(id)
        .catch((e): ServerTest => ({ ok: false, reachable: false, authenticated: null, latencyMs: null, message: String(e) }))
        .then((r) => live && setChecks((c) => ({ ...c, [id]: r })));
    }
    return () => {
      live = false;
    };
  }, [ids]);
  return checks;
}

function hostStatus(check: ServerTest | "testing" | undefined): Status {
  if (!check || check === "testing") return { tone: "muted", label: "Checking…" };
  if (check.ok) return { tone: "ok", label: "Online", title: check.message };
  return { tone: check.reachable ? "warn" : "fail", label: check.reachable ? "Needs attention" : "Unreachable", title: check.message };
}

const CyberCtfLogo = () => (
  <TypeIcon>
    {/* eslint-disable-next-line @next/next/no-img-element -- static export, plain asset */}
    <img src="/logo-mark.svg" alt="Cyber CTF" className="size-4 object-contain" draggable={false} />
  </TypeIcon>
);

const DockerLogo = () => (
  <TypeIcon>
    {/* eslint-disable-next-line @next/next/no-img-element -- static export, plain asset */}
    <img src="/brands/docker.svg" alt="Docker" className="size-5 object-contain" draggable={false} />
  </TypeIcon>
);

/**
 * "Where should it run?": this machine (Docker, or a VM on the hypervisor chosen in Settings),
 * then the player's servers, then their cloud accounts, each with its logo and live status.
 * Targets the lab can't run on stay visible, disabled, saying why.
 */
export function RunOnPicker({
  title,
  hosts,
  hostOk,
  localNote,
  dockerRunning,
  localVm,
  hosted,
  value,
  onChange,
  disabled,
}: {
  title: string;
  hosts: ServerHost[];
  hostOk: (h: ServerHost) => boolean;
  localNote: string;
  /** Container labs: whether a Docker engine answers here (null = unknown / not relevant). */
  dockerRunning: boolean | null;
  /** The local hypervisor this (container) lab can run a VM on: Settings' choice, else the first ready. */
  localVm: Provider | null;
  /** Cyber CTF can run this lab for the player (no install, a public URL). */
  hosted: boolean;
  value: RunTarget;
  onChange: (t: RunTarget) => void;
  disabled: boolean;
}) {
  const checks = useHostChecks(hosts);
  const hostOption = (h: ServerHost): Option => {
    const kind = KIND[h.provider]?.label ?? h.provider;
    const cloud = CLOUDS.has(h.provider);
    const ok = hostOk(h);
    return {
      target: { kind: "host", id: h.id },
      title: h.name,
      subtitle: `${kind}${cloud ? ", billed to you" : ""} · ${h.host}`,
      ok,
      why: `This lab doesn't support ${kind}`,
      logo: <ProviderGlyph provider={h.provider} />,
      status: ok ? hostStatus(checks[h.id]) : undefined,
    };
  };
  const local: Option[] = [
    {
      target: { kind: "local" },
      title: "This machine",
      subtitle: localNote,
      ok: true,
      logo: dockerRunning === null ? <HypervisorLogo provider={null} /> : <DockerLogo />,
      status:
        dockerRunning === null
          ? undefined
          : dockerRunning
            ? { tone: "ok", label: "Running" }
            : { tone: "warn", label: "Docker stopped", title: "Start your Docker engine (Machine page)" },
    },
  ];
  if (localVm) {
    local.push({
      target: { kind: "local-vm", provider: localVm },
      title: "This machine, in a VM",
      subtitle: `${PROVIDER_LABELS[localVm] ?? localVm} · isolated from your system`,
      ok: true,
      logo: <HypervisorLogo provider={localVm} />,
      status: { tone: "ok", label: "Ready", title: "Hypervisor chosen in Settings" },
    });
  }
  const groups: { label: string; options: Option[] }[] = [
    { label: "This machine", options: local },
    {
      label: "Cyber CTF",
      options: hosted
        ? [
            {
              target: { kind: "hosted" },
              title: "Hosted by Cyber CTF",
              subtitle: "Nothing to install · opens in your browser",
              ok: true,
              logo: <CyberCtfLogo />,
              status: { tone: "ok", label: "Available" },
            } satisfies Option,
          ]
        : [],
    },
    { label: "Servers", options: hosts.filter((h) => !CLOUDS.has(h.provider)).map(hostOption) },
    { label: "Cloud", options: hosts.filter((h) => CLOUDS.has(h.provider)).map(hostOption) },
  ].filter((g) => g.options.length > 0);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold tracking-tight text-foreground">Where should it run?</p>
        <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{title}</p>
      </div>
      {groups.map((g) => (
        <div key={g.label} className="space-y-1.5">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">{g.label}</p>
          <RadioList label={g.label}>
            {g.options.map((o) => (
              <RadioRow
                key={targetKey(o.target)}
                selected={targetKey(value) === targetKey(o.target)}
                onSelect={() => onChange(o.target)}
                disabled={disabled || !o.ok}
                hint={o.ok ? o.status?.title : o.why}
                title={o.title}
                subtitle={o.ok ? o.subtitle : "Not supported by this lab"}
                leading={o.logo}
                trailing={
                  o.status && (
                    <StatusPill tone={o.status.tone}>
                      <span className="whitespace-nowrap">{o.status.label}</span>
                    </StatusPill>
                  )
                }
              />
            ))}
          </RadioList>
        </div>
      ))}
    </div>
  );
}
