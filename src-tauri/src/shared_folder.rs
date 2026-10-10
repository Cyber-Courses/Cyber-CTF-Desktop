//! A folder on this computer shared with the attack box: tools, wordlists and notes go in, loot
//! comes out, and it all survives the box being removed with its lab. Chosen in the setup and in
//! Settings (off until then); mounted at `/shared` in the container attack box and in the attack VM.
//! Kept in the app's data folder, so the background deploy worker sees the same choice.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// Where it shows up inside the attack box.
pub const MOUNT_POINT: &str = "/shared";

static FILE: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedFolder {
    pub enabled: bool,
    /// The folder on this computer; the default one when unset.
    pub path: Option<String>,
}

/// Points the setting at the app's data folder. Called at start by the app and the deploy worker.
pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = FILE.set(dir.join("shared-folder.json"));
    }
}

/// The suggested folder: `CyberCTF/shared` in the home folder.
pub fn default_path() -> Option<PathBuf> {
    crate::platform::home_dir().map(|h| h.join("CyberCTF").join("shared"))
}

fn load() -> SharedFolder {
    FILE.get().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The folder to mount, when sharing is on: created if missing. None when off or unusable.
pub fn current() -> Option<PathBuf> {
    let s = load();
    if !s.enabled {
        return None;
    }
    let path = s.path.map(PathBuf::from).or_else(default_path)?;
    std::fs::create_dir_all(&path).ok()?;
    path.is_dir().then_some(path)
}

fn check(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::Invalid("choose a full folder path".into()));
    }
    // Mounted as `host:container` for Docker and quoted in a Vagrantfile: keep it to plain paths.
    if path.to_string_lossy().chars().any(|c| matches!(c, '"' | '\n' | '\r')) {
        return Err(Error::Invalid("this folder's name has characters that can't be shared; pick another".into()));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFolderInfo {
    pub enabled: bool,
    pub path: String,
    pub mount_point: &'static str,
}

#[tauri::command]
pub fn shared_folder_get() -> SharedFolderInfo {
    let s = load();
    let path = s.path.or_else(|| default_path().map(|p| p.display().to_string())).unwrap_or_default();
    SharedFolderInfo { enabled: s.enabled, path, mount_point: MOUNT_POINT }
}

/// Turns sharing on or off and sets the folder (created now, so a wrong path shows at once).
#[tauri::command]
pub fn shared_folder_set(enabled: bool, path: String) -> Result<SharedFolderInfo> {
    let p = PathBuf::from(path.trim());
    if enabled {
        check(&p)?;
        std::fs::create_dir_all(&p).map_err(|e| Error::Invalid(format!("couldn't create {}: {e}", p.display())))?;
    }
    let file = FILE.get().ok_or_else(|| Error::Invalid("settings aren't ready yet".into()))?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let s = SharedFolder { enabled, path: (!path.trim().is_empty()).then(|| p.display().to_string()) };
    std::fs::write(file, serde_json::to_string_pretty(&s).map_err(|e| Error::Invalid(e.to_string()))?)?;
    Ok(shared_folder_get())
}

/// Opens the folder in the system's file manager.
#[tauri::command]
pub fn shared_folder_open() -> Result<()> {
    let path = current().ok_or_else(|| Error::Invalid("folder sharing is off".into()))?;
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(&path).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_absolute_paths_are_shared() {
        assert!(check(Path::new("relative/dir")).is_err());
        assert!(check(Path::new("/home/a\"b")).is_err());
        assert!(check(Path::new("/Users/alex/CyberCTF/shared")).is_ok());
        assert!(check(Path::new("/Users/alex/My Tools")).is_ok());
    }

    #[test]
    fn the_default_is_in_the_home_folder() {
        let p = default_path().unwrap();
        assert!(p.ends_with("CyberCTF/shared"));
    }
}
