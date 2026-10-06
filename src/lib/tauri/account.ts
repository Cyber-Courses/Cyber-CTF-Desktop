import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  loggedIn: boolean;
  name: string | null;
  email: string | null;
}

export const authStatus = () => invoke<AuthStatus>("auth_status");
/** Opens the system browser on cyberauth.co and resolves once the player is back. */
export const authLogin = () => invoke<AuthStatus>("auth_login");
export const authLogout = () => invoke<void>("auth_logout");

/** GraphQL against CyberBackend; the Rust side attaches the player's token. */
export const apiQuery = <T>(query: string, variables?: Record<string, unknown>) => invoke<T>("api_query", { query, variables });

/**
 * startLab + download at the pinned commit + run with the launch token. VM labs run on
 * this machine with `provider`, or on the server `host` (a host id) when given.
 */

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
