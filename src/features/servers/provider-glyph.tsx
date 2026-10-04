import { Server } from "lucide-react";
import type { RemoteProvider } from "@/lib/tauri";
import { TypeIcon } from "@/components/ui/type-icon";

/** Brand logos we can show for a host/hypervisor. VMware/Broadcom's logo needs their approval,
 *  and the local hypervisors (VirtualBox, Hyper-V, Parallels, QEMU, UTM) have no bundled mark
 *  yet, so those fall back to a neutral glyph. Drop an SVG in public/brands and add it here to
 *  light one up. */
const LOGO: Partial<Record<RemoteProvider, { src: string; alt: string }>> = {
  proxmox: { src: "/brands/proxmox-full-lockup-inverted-color.svg", alt: "Proxmox" },
  aws: { src: "/brands/aws.svg", alt: "Amazon Web Services" },
  azure: { src: "/brands/azure.svg", alt: "Microsoft Azure" },
  gcp: { src: "/brands/gcp.svg", alt: "Google Cloud" },
};

/** The leading mark for a host row: the provider's logo when we have one, else a neutral badge. */
export function ProviderGlyph({ provider }: { provider: RemoteProvider }) {
  const logo = LOGO[provider];
  if (!logo) {
    return (
      <TypeIcon>
        <Server className="size-4" />
      </TypeIcon>
    );
  }
  return (
    <span className="grid size-8 shrink-0 place-items-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- static export, plain asset */}
      <img src={logo.src} alt={logo.alt} className="max-h-4 max-w-full object-contain" draggable={false} />
    </span>
  );
}
