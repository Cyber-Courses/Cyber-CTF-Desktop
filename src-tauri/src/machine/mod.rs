//! This machine: what it has installed (system check), its setup self-tests, and the
//! workloads and storage the Machine page shows.

pub mod images;
pub mod selftest;
pub mod storage;
pub mod system;
pub mod workloads;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// Where installed labs live: `<app data>/labs/<lab id>/`.
fn labs_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("labs"))
}

/// Every installed lab: its id and its folder.
fn installed_labs(app: &AppHandle) -> Vec<(String, PathBuf)> {
    let Ok(dir) = labs_dir(app) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries.flatten().filter(|e| e.path().is_dir()).map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).collect()
}
