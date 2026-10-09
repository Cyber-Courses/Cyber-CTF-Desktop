"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { dockerStartEngine, dockerUseEngine, type DockerEngine, type SystemReport } from "@/lib/tauri";
import { ENGINES, Engine } from "@/features/machine/setup-steps/engines";
import { CmdRow, Log } from "@/features/machine/setup-steps/parts";
import { Choice, ChoiceAction, ChoiceGrid } from "@/components/ui/choice-card";
import { chosenEngine, isDockerReady } from "@/features/machine/setup-steps/steps";
import { MachineSetupState } from "@/features/machine/setup-steps/use-machine-setup";
import { openExternal, tell } from "@/lib/failure";
import { useT } from "@/lib/i18n";

export function EngineStep({ report, setup }: { report: SystemReport; setup: MachineSetupState }) {
  const t = useT();
  const isWin = report.os === "windows";
  const isMac = report.os === "macos";
  const ready = isDockerReady(report);
  const { installing, installerOpened, install, onRefresh } = setup;
  const engines = ENGINES.filter((e) => e.os.includes(report.os));
  const recommended = isMac || isWin ? "docker-desktop" : "docker-engine";
  // One engine is enough; the pick lives in the setup state so the flow can wait for it.
  const choice = chosenEngine(report, setup);
  // Several engines can run at once; Docker talks to one. Switching = `docker context use`.
  const [switching, setSwitching] = useState(false);
  const switchTo = (engine: DockerEngine) => {
    setSwitching(true);
    dockerUseEngine(engine)
      .catch(tell(t("machine.errors.switchEngine")))
      .finally(() => {
        setSwitching(false);
        onRefresh();
      });
  };
  const inUse = report.dockerEngine === choice.id;
  // Installed but stopped: start it from here instead of sending the player to do it.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const start = () => {
    setStarting(true);
    setStartError(null);
    dockerStartEngine(choice.id)
      .catch((e) => setStartError(String(e)))
      .finally(() => {
        setStarting(false);
        onRefresh();
      });
  };
  return (
    <div className="space-y-3">
      <ChoiceGrid>
        {engines.map((e) => (
          <Choice
            key={e.id}
            selected={e.id === choice.id}
            onSelect={() => setup.setEngine(e.id)}
            mark={<EngineLogo engine={e} />}
            title={e.name}
            note={t(e.note)}
            badge={
              report.dockerEngine === e.id
                ? "in use"
                : report.dockerEnginesRunning?.includes(e.id)
                  ? "running"
                  : e.id === recommended
                    ? "recommended"
                    : undefined
            }
          />
        ))}
      </ChoiceGrid>
      {/* Only when there is something to do: an engine in use already says so on its card. */}
      {!inUse && (
        <ChoiceAction>
          {report.dockerEnginesRunning?.includes(choice.id) ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">
                {t("machine.engine.otherRunning", {
                  engine: choice.name,
                  current: engines.find((e) => e.id === report.dockerEngine)?.name ?? t("machine.engine.anotherEngine"),
                })}
              </span>
              <Button variant="primary" size="sm" disabled={switching} onClick={() => switchTo(choice.id)}>
                {switching ? (
                  <>
                    <Spinner className="size-3.5" /> {t("machine.engine.switching")}
                  </>
                ) : (
                  t("machine.engine.use", { engine: choice.name })
                )}
              </Button>
            </>
          ) : report.docker.installed && !ready ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">
                {startError ?? (starting ? t("machine.engine.starting", { engine: choice.name }) : t("machine.engine.notRunning", { engine: choice.name }))}
              </span>
              <span className="flex shrink-0 gap-2">
                {startError && (
                  <Button variant="outline" size="sm" onClick={() => openExternal(choice.url)}>
                    <ExternalLink className="size-3.5" /> {t("machine.engine.get", { name: choice.name })}
                  </Button>
                )}
                <Button variant="primary" size="sm" disabled={starting} onClick={start}>
                  {starting ? (
                    <>
                      <Spinner className="size-3.5" /> {t("machine.engine.startingButton")}
                    </>
                  ) : (
                    t("machine.engine.start", { engine: choice.name })
                  )}
                </Button>
              </span>
            </>
          ) : choice.id === recommended && !report.docker.installed ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">{t("machine.engine.canInstall", { name: choice.name })}</span>
              {!installerOpened ? (
                <Button variant="primary" size="sm" onClick={() => install("docker", "docker", t("machine.engine.installLog"))} disabled={installing !== null}>
                  {installing === "docker" ? (
                    <>
                      <Spinner className="size-3.5" /> {t("machine.engine.installing")}
                    </>
                  ) : (
                    t("machine.engine.install", { name: choice.name })
                  )}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> {t("machine.engine.recheck")}
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">{t("machine.engine.installThenRecheck", { engine: choice.name })}</span>
              <span className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => openExternal(choice.url)}>
                  <ExternalLink className="size-3.5" /> {t("machine.engine.get", { name: choice.name })}
                </Button>
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> {t("machine.engine.recheck")}
                </Button>
              </span>
            </>
          )}
        </ChoiceAction>
      )}
      {!ready && installerOpened && (
        <p className="text-[0.75rem] text-muted-foreground">
          {choice.id === "docker-desktop" ? t("machine.engine.finishDockerDesktop") : t("machine.engine.finishOther", { engine: choice.name })}
        </p>
      )}
      {!ready && isWin && <p className="text-[0.75rem] text-muted-foreground">{t("machine.engine.windowsReboot")}</p>}
      {!ready && !isMac && !isWin && choice.id === "docker-engine" && (
        <div className="space-y-2 rounded-control bg-glass shadow-[inset_0_0_0_1px_var(--border)] p-3 text-left text-[0.75rem] text-muted-foreground">
          <p>{t("machine.engine.linuxPostInstall")}</p>
          <CmdRow cmd="sudo usermod -aG docker $USER" />
          <CmdRow cmd="sudo systemctl enable --now docker" />
          <p>{t("machine.engine.linuxRelog")}</p>
        </div>
      )}
      <Log setup={setup} of={["docker"]} />
      <EngineTrademarks />
    </div>
  );
}

/** The logo of a Docker-compatible engine, for other screens (e.g. the Machine page). */
export function EngineMark({ id }: { id: DockerEngine }) {
  const e = ENGINES.find((x) => x.id === id);
  return e ? <EngineLogo engine={e} /> : null;
}

/** Brand mark in a fixed square. App icons (`tile`) fill it; bare marks sit on a white logo
 *  tile (white in every mode) so dark artwork stays legible. */
function EngineLogo({ engine }: { engine: Engine }) {
  return engine.tile ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={engine.logo} alt="" className="size-8 shrink-0 rounded-control object-contain" />
  ) : (
    <span className="logo-tile flex size-8 shrink-0 items-center justify-center rounded-control p-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={engine.logo} alt="" className="size-full object-contain" />
    </span>
  );
}

function EngineTrademarks() {
  const t = useT();
  return <p className="pt-1 text-left text-[0.6875rem] leading-relaxed text-faint">{t("machine.engine.trademarks")}</p>;
}
