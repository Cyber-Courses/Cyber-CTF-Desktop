import { invoke } from "@tauri-apps/api/core";

/** Opens Settings in its own window (reused/focused if already open). */
export const openSettings = () => invoke<void>("open_settings");
/** Relaunches the app (applies an installed update). */
export const restartApp = () => invoke<void>("restart_app");
