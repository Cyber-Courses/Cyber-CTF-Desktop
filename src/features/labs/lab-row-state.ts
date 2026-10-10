import type { LabStatus } from "@/lib/tauri";

/** What a list row says the lab is doing, most pressing first. */
export type RowPhase = "busy" | "starting" | "running" | "paused" | "shutDown" | "solved" | "notStarted";

export function rowPhase({
  status,
  busy,
  deploying,
  solved,
}: {
  status: LabStatus | undefined;
  /** This session runs an operation on it. */
  busy: boolean;
  /** The backend deploys it (e.g. started before a reload). */
  deploying: boolean;
  solved: boolean;
}): RowPhase {
  const running = status?.running ?? false;
  if (busy) return "busy";
  if (deploying && !running) return "starting";
  if (running) return "running";
  if (status?.parked) return status.parked === "pause" ? "paused" : "shutDown";
  return solved ? "solved" : "notStarted";
}
