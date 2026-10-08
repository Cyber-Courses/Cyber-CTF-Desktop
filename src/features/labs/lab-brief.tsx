"use client";

import { useEffect, useState } from "react";
import { Markdown } from "@/components/ui/markdown";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { apiQuery } from "@/lib/tauri";

/** The lab's brief (markdown from CyberBackend). */
export function LabBrief({ labId }: { labId: string }) {
  const [content, setContent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    apiQuery<{ labs: { contentMd: string | null }[] }>(`query($id: ID!) { labs(where: { id: { eq: $id } }) { contentMd } }`, { id: labId })
      .then((d) => setContent(d.labs[0]?.contentMd ?? null))
      .catch(() => setContent(null));
  }, [labId]);
  return (
    <Panel>
      <PanelHeader title="Brief" />
      <div className="p-4">
        {content === undefined ? (
          <div className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
            <Spinner className="size-3.5" /> Loading the brief…
          </div>
        ) : content ? (
          <Markdown content={content} className="space-y-3 text-[0.8125rem] leading-relaxed text-foreground" />
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">No briefing for this lab yet. Start it and dig in.</p>
        )}
      </div>
    </Panel>
  );
}
