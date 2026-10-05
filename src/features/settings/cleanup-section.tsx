"use client";

import { DownloadsPanel } from "@/features/machine/downloads-panel";
import { RunningNowPanel } from "@/features/machine/running-now-panel";

/** Cleanup: stop anything still running on this machine (a stuck or leftover lab), and reclaim
 *  disk from downloaded images and VM boxes. Reuses the Machine page's panels. */
export function CleanupSection() {
  return (
    <section className="space-y-3">
      <div className="px-0.5">
        <h2 className="text-sm font-semibold tracking-tight">Cleanup</h2>
        <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
          Tear down anything still running on this machine (a leftover or stuck lab), and reclaim disk from downloaded images and VM boxes.
        </p>
      </div>
      <RunningNowPanel refreshKey={null} />
      <DownloadsPanel />
    </section>
  );
}
