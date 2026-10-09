"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LogConsole } from "@/components/ui/log-console";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { installedTools, uninstallDependency, type Dependency, type InstalledTool } from "@/lib/tauri";
import { formatAgo } from "@/lib/format";
import { warn } from "@/lib/failure";

const NAMES: Record<Dependency, string> = {
  docker: "Docker",
  vagrant: "Vagrant",
  terraform: "Terraform",
  virtualbox: "VirtualBox",
  qemu: "QEMU",
  utm: "UTM",
  libvirt: "libvirt",
  awscli: "AWS CLI",
  azurecli: "Azure CLI",
  gcloud: "Google Cloud CLI",
  wsl: "WSL",
};

/** What setup installed under that name: Docker Engine on Linux (get.docker.com), Docker Desktop elsewhere. */
function toolName(dep: Dependency): string {
  if (dep !== "docker") return NAMES[dep];
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Linux") ? "Docker Engine" : "Docker Desktop";
}

/** The tools Cyber CTF installed during setup, each removable. Hidden when there are none; a tool
 *  the player had before is never listed, so nothing of theirs can be removed from here. */
export function InstalledToolsPanel() {
  const [tools, setTools] = useState<InstalledTool[]>([]);
  const [asking, setAsking] = useState<Dependency | null>(null);
  const [removing, setRemoving] = useState<Dependency | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const load = useCallback(() => {
    installedTools().then(setTools).catch(warn("reading the tools Cyber CTF installed"));
  }, []);
  useEffect(load, [load]);

  const remove = async (dep: Dependency) => {
    setAsking(null);
    setRemoving(dep);
    setLog([`Removing ${toolName(dep)}…`]);
    try {
      await uninstallDependency(dep, (line) => setLog((l) => [...l, line]));
    } catch (e) {
      setLog((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setRemoving(null);
      load();
    }
  };

  if (tools.length === 0 && log.length === 0) return null;
  const now = Date.now();
  return (
    <Panel>
      <PanelHeader title="Tools Cyber CTF installed" meta={tools.length ? `${tools.length} installed` : undefined} />
      <p className="border-b border-border px-4 py-2.5 text-[0.75rem] text-muted-foreground">
        Installed during setup. Remove the ones you no longer need; tools you had before aren&apos;t listed.
      </p>
      <ul>
        {tools.map((t) => (
          <li
            key={t.dependency}
            className="flex min-h-[3.25rem] items-center gap-3 border-t border-border px-4 py-2 transition-colors first:border-t-0 hover:bg-glass"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[0.8125rem] font-medium text-foreground">{toolName(t.dependency)}</p>
              <p className="font-mono text-[0.6875rem] text-faint">installed {formatAgo(t.at * 1000, now)}</p>
            </div>
            <Button variant="outline" size="xs" disabled={removing !== null} onClick={() => setAsking(t.dependency)}>
              <Trash2 className="size-3" /> {removing === t.dependency ? "Removing…" : "Remove"}
            </Button>
          </li>
        ))}
      </ul>
      {log.length > 0 && (
        <div className="border-t border-border p-4">
          <LogConsole lines={log} running={removing !== null} title="Remove" />
        </div>
      )}
      {asking && (
        <ConfirmDialog title={`Remove ${toolName(asking)}?`} confirmLabel="Remove" onConfirm={() => remove(asking)} onCancel={() => setAsking(null)}>
          Labs that need {toolName(asking)} won&apos;t start until it&apos;s installed again (setup can reinstall it). Your labs and settings are kept.
        </ConfirmDialog>
      )}
    </Panel>
  );
}
