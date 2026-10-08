"use client";

import { DownloadsPanel } from "@/features/machine/downloads-panel";
import { RunningNowPanel } from "@/features/machine/running-now-panel";
import { SectionTitle } from "@/features/settings/settings-layout";

/** Cleanup: stop anything still running on this machine (a stuck or leftover lab), and reclaim
 *  disk from downloaded images and VM boxes. Reuses the Machine page's panels. */
export function CleanupSection() {
  return (
    <section className="space-y-4">
      <SectionTitle
        title="Cleanup"
        description="Tear down anything still running on this machine (a leftover or stuck lab), and reclaim disk from downloaded images and VM boxes."
      />
      <RunningNowPanel refreshKey={null} />
      <DownloadsPanel />
    </section>
  );
}
