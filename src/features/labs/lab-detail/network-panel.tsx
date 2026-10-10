"use client";

import { Panel, PanelHeader } from "@/components/ui/panel";
import { NetworkDiagram } from "@/features/labs/network-diagram";
import type { Attacker } from "@/features/labs/network-diagram/model";
import type { NetworkNote } from "@/features/labs/lab-detail/lab-state";
import type { ExegolStatus, LabStatus } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

/** The attack box as the diagram draws it. A server or cloud lab runs its attack box on the lab
 *  host, which only that host's report sees; a local one reports itself. */
function diagramAttacker(status: LabStatus, remote: boolean, box: ExegolStatus | null): Attacker {
  if (remote) return status.attacker ? { running: true, ip: status.attacker.ip, labNetwork: status.attacker.labNetwork } : null;
  return box ? { running: box.running, ip: box.ip, labNetwork: box.labNetwork } : null;
}

/** The lab's network: its diagram, or a note saying why there is none yet (see networkView). */
export function NetworkPanel({
  view,
  status,
  remote,
  box,
  meta,
}: {
  view: "diagram" | NetworkNote;
  status: LabStatus | undefined;
  remote: boolean;
  /** The local attack box's last status. */
  box: ExegolStatus | null;
  /** The runtime word for the header, when the lab has one. */
  meta: string | undefined;
}) {
  const t = useT();
  if (view === "diagram" && status) {
    return <NetworkDiagram machines={status.machines} networks={status.networks} host={status.host} attacker={diagramAttacker(status, remote, box)} />;
  }
  return (
    <Panel>
      <PanelHeader title={t("labs.detail.network")} meta={meta} />
      <p className="dotted-canvas px-6 py-14 text-center text-[0.8125rem] text-muted-foreground">{t(`labs.detail.${view as NetworkNote}`)}</p>
    </Panel>
  );
}
