//! Where server and cloud profiles are kept: `server.json` in app data (non-secret settings;
//! secrets are in `secrets`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::profile::HostProfile;
use crate::error::{Error, Result};

const STORE_FILE: &str = "server.json";

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Store {
    /// The server VM labs run on when none is picked (never a cloud account).
    pub default: Option<String>,
    pub hosts: Vec<HostProfile>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(STORE_FILE))
}

pub(super) fn load(app: &AppHandle) -> Result<Store> {
    match std::fs::read_to_string(store_path(app)?) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| Error::Invalid(format!("server.json: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.into()),
    }
}

pub(super) fn save(app: &AppHandle, store: &Store) -> Result<()> {
    let raw = serde_json::to_string_pretty(store).map_err(|e| Error::Invalid(e.to_string()))?;
    std::fs::write(store_path(app)?, raw)?;
    Ok(())
}

pub(super) fn find(store: &Store, id: &str) -> Result<HostProfile> {
    store.hosts.iter().find(|h| h.id == id).cloned().ok_or_else(|| Error::Invalid(format!("server host `{id}` not found")))
}

/// A saved host by id, if the store reads and has it.
pub(super) fn saved_host(app: &AppHandle, id: &str) -> Option<HostProfile> {
    load(app).ok()?.hosts.into_iter().find(|h| h.id == id)
}

/// A saved host by id, with the reason when it can't be had.
pub(super) fn load_host(app: &AppHandle, id: &str) -> Result<HostProfile> {
    find(&load(app)?, id)
}
