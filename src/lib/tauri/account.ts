import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  loggedIn: boolean;
  name: string | null;
  email: string | null;
  /** The OS keychain couldn't be read (locked, or no Secret Service): why signed out. */
  keychainError?: string | null;
}

export const authStatus = () => invoke<AuthStatus>("auth_status");
/** Opens the system browser on cyberauth.co and resolves once the player is back. */
export const authLogin = () => invoke<AuthStatus>("auth_login");
export const authLogout = () => invoke<void>("auth_logout");

/** GraphQL against CyberBackend; the Rust side attaches the player's token. */
export const apiQuery = <T>(query: string, variables?: Record<string, unknown>) => invoke<T>("api_query", { query, variables });
