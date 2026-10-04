import { Server } from "lucide-react";
import type { Provider } from "@/lib/tauri";

/** Brand marks we ship for local hypervisors (Simple Icons, CC0; marks belong to their owners).
 *  No VMware mark: it needs Broadcom's approval. Others fall back to a neutral server icon. */
const LOGOS: Partial<Record<Provider, string>> = {
  virtualbox: "/brands/virtualbox.svg",
  qemu: "/brands/qemu.svg",
};

/** A hypervisor's logo on a light tile (like the container engines), or a neutral icon. */
export function HypervisorLogo({ provider }: { provider: Provider | null | undefined }) {
  const logo = provider ? LOGOS[provider] : undefined;
  return logo ? (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white p-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element -- static export, plain asset */}
      <img src={logo} alt="" className="size-full object-contain" />
    </span>
  ) : (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground">
      <Server className="size-4" />
    </span>
  );
}
