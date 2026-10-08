"use client";

import { DownloadsPanel } from "@/features/machine/downloads-panel";
import { RunningNowPanel } from "@/features/machine/running-now-panel";
import { SectionTitle } from "@/features/settings/settings-layout";
import { InstalledToolsPanel } from "@/features/settings/installed-tools-panel";

/** Cleanup: stop anything still running on this machine (a stuck or leftover lab), reclaim disk
 *  from downloaded images and VM boxes, and remove tools Cyber CTF installed. Reuses the Machine
 *  page's panels. */
export function CleanupSection() {
  return (
    <section className="space-y-4">
      <SectionTitle
        title="Cleanup"
        description="Tear down anything still running on this machine (a leftover or stuck lab), reclaim disk from downloaded images and VM boxes, and remove tools Cyber CTF installed."
      />
      <RunningNowPanel refreshKey={null} />
      <DownloadsPanel />
      <InstalledToolsPanel />
    </section>
  );
}
