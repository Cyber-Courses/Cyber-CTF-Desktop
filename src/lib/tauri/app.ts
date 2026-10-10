import { invoke } from "@tauri-apps/api/core";

/** Opens Settings in its own window (reused/focused if already open). */
export const openSettings = () => invoke<void>("open_settings");
/** Relaunches the app (applies an installed update). */
export const restartApp = () => invoke<void>("restart_app");

export interface AgentInfo {
  installId: string;
  name: string;
  arch: string;
  capabilities: string[];
}

/** This machine's launcher-agent identity (for the Settings screen). */
export const agentInfo = () => invoke<AgentInfo>("agent_info");

/** Answer a cloud-launch confirmation the agent asked for (a website launch onto a cloud account). */
export const confirmLaunch = (sessionId: string, approve: boolean) => invoke<void>("confirm_launch", { sessionId, approve });
