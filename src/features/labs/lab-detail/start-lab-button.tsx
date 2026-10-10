"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortChoice } from "@/features/labs/port-mode-prompt";
import { RunOnDialog, RunOnPicker, type RunTarget } from "@/features/labs/run-on";
import type { RunTargetChoice } from "@/features/labs/lab-detail/use-run-target";
import type { Lab } from "@/features/labs/use-labs";
import { useT } from "@/lib/i18n";

/** Start lab: with somewhere else to run it (servers, a VM here, hosted), asks where first in
 *  "Where should it run?"; otherwise starts here right away. */
export function StartLabButton({
  lab,
  run,
  isDocker,
  loggedIn,
  hostedLive,
  busy,
  dockerRunning,
  onStart,
}: {
  lab: Lab;
  run: RunTargetChoice;
  isDocker: boolean;
  loggedIn: boolean;
  /** A hosted session of this lab is up: one run at a time. */
  hostedLive: boolean;
  busy: boolean;
  dockerRunning: boolean | null;
  onStart: (target: RunTarget) => void;
}) {
  const t = useT();
  const [choosing, setChoosing] = useState(false);
  const rt = lab.runtime;
  return (
    <div className="relative">
      <Button
        variant="primary"
        onClick={() => (run.hasChoice ? setChoosing(true) : onStart({ kind: "local" }))}
        disabled={!loggedIn || !rt || hostedLive}
        title={!rt ? t("labs.detail.noRuntime") : !loggedIn ? t("labs.detail.signInHint") : hostedLive ? t("labs.detail.hostedLive") : undefined}
        aria-haspopup={run.hasChoice ? "dialog" : undefined}
      >
        <Play className="size-3.5" /> {t("labs.detail.startLab")}
      </Button>
      {choosing && (
        <RunOnDialog
          onClose={() => setChoosing(false)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>
                {t("labs.detail.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setChoosing(false);
                  onStart(run.chosen());
                }}
              >
                <Play className="size-3.5" /> {t("labs.detail.start")}
              </Button>
            </>
          }
        >
          <RunOnPicker
            title={lab.title}
            hosts={run.hosts}
            hostOk={run.hostOk}
            localNote={isDocker ? t("labs.detail.localNoteContainers") : t("labs.detail.localNoteVm")}
            localVm={run.localVm}
            hosted={!!rt?.hosted}
            dockerRunning={isDocker ? dockerRunning : null}
            value={run.runOn}
            onChange={run.setRunOn}
            disabled={busy}
            localExtra={
              run.runOn.kind === "local" &&
              isDocker && (
                <div className="space-y-1.5">
                  <p className="section-label">{t("labs.detail.portsHere")}</p>
                  <PortChoice value={run.ports} onChange={run.setPorts} />
                </div>
              )
            }
          />
        </RunOnDialog>
      )}
    </div>
  );
}
