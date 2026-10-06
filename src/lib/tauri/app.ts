import { invoke } from "@tauri-apps/api/core";

/** Opens Settings in its own window (reused/focused if already open). */
export const openSettings = () => invoke<void>("open_settings");
