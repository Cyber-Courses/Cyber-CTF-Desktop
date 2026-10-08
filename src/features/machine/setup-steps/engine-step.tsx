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

export function EngineStep({ report, setup }: { report: SystemReport; setup: MachineSetupState }) {
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
      .catch(tell("Couldn't switch the Docker engine"))
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
            note={e.note}
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
                {choice.name} is running, but Docker uses {engines.find((e) => e.id === report.dockerEngine)?.name ?? "another engine"} right now.
              </span>
              <Button variant="learn" size="sm" disabled={switching} onClick={() => switchTo(choice.id)}>
                {switching ? (
                  <>
                    <Spinner className="size-3.5" /> Switching…
                  </>
                ) : (
                  `Use ${choice.name}`
                )}
              </Button>
            </>
          ) : report.docker.installed && !ready ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">
                {startError ?? (starting ? `Starting ${choice.name}… the first start can take a minute.` : `${choice.name} is installed but not running.`)}
              </span>
              <span className="flex shrink-0 gap-2">
                {startError && (
                  <Button variant="outline" size="sm" onClick={() => openExternal(choice.url)}>
                    <ExternalLink className="size-3.5" /> Get {choice.name}
                  </Button>
                )}
                <Button variant="learn" size="sm" disabled={starting} onClick={start}>
                  {starting ? (
                    <>
                      <Spinner className="size-3.5" /> Starting…
                    </>
                  ) : (
                    `Start ${choice.name}`
                  )}
                </Button>
              </span>
            </>
          ) : choice.id === recommended && !report.docker.installed ? (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Cyber CTF can install {choice.name} for you.</span>
              {!installerOpened ? (
                <Button
                  variant="learn"
                  size="sm"
                  onClick={() => install("docker", "docker", "Installing the container engine…")}
                  disabled={installing !== null}
                >
                  {installing === "docker" ? (
                    <>
                      <Spinner className="size-3.5" /> Installing…
                    </>
                  ) : (
                    `Install ${choice.name}`
                  )}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="text-[0.8125rem] text-muted-foreground">Install {choice.name}, start it, then re-check.</span>
              <span className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => openExternal(choice.url)}>
                  <ExternalLink className="size-3.5" /> Get {choice.name}
                </Button>
                <Button variant="outline" size="sm" onClick={() => onRefresh()}>
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
              </span>
            </>
          )}
        </ChoiceAction>
      )}
      {!ready && installerOpened && (
        <p className="text-[0.75rem] text-muted-foreground">
          {choice.id === "docker-desktop"
            ? "Finish in Docker’s installer, launch Docker Desktop, then press Re-check."
            : `Finish installing ${choice.name}, start it, then press Re-check.`}
        </p>
      )}
      {!ready && isWin && (
        <p className="text-[0.75rem] text-muted-foreground">A reboot may be needed after enabling WSL. If Docker says virtualization is off, go back a step.</p>
      )}
      {!ready && !isMac && !isWin && choice.id === "docker-engine" && (
        <div className="space-y-2 rounded-lg border border-border bg-[#0f0f0f] p-3 text-left text-[0.75rem] text-muted-foreground">
          <p>After Docker Engine installs, let your user run it and start the service:</p>
          <CmdRow cmd="sudo usermod -aG docker $USER" />
          <CmdRow cmd="sudo systemctl enable --now docker" />
          <p>Then log out and back in.</p>
        </div>
      )}
      <Log setup={setup} />
      <EngineTrademarks />
    </div>
  );
}

/** Brand mark in a fixed square. App icons (`tile`) fill it; bare marks sit on a light chip so dark artwork stays legible. */
/** The logo of a Docker-compatible engine, for other screens (e.g. the Machine page). */
export function EngineMark({ id }: { id: DockerEngine }) {
  const e = ENGINES.find((x) => x.id === id);
  return e ? <EngineLogo engine={e} /> : null;
}

function EngineLogo({ engine }: { engine: Engine }) {
  return engine.tile ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={engine.logo} alt="" className="size-8 shrink-0 rounded-lg object-contain" />
  ) : (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white p-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={engine.logo} alt="" className="size-full object-contain" />
    </span>
  );
}

function EngineTrademarks() {
  return (
    <p className="pt-1 text-left text-[0.6875rem] leading-relaxed text-muted-foreground/70">
      Docker and the Docker logo are trademarks of Docker, Inc. OrbStack and Colima marks belong to their respective owners. Cyber CTF isn&apos;t affiliated
      with any of them.
    </p>
  );
}
