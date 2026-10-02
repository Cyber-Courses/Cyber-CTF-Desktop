//! Lab runtimes. A lab is a directory under `<app data>/labs/<lab id>/` holding
//! either a `docker-compose.yml` (Docker labs) or a `Vagrantfile` (VM labs).
//! The UI only ever passes a lab id and a runtime; paths and commands are built here.

mod docker;
pub mod providers;
mod vm;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// Mirrors `LabRuntime` in CyberBackend.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Runtime {
    Docker,
    Vm,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub name: String,
    pub state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabStatus {
    pub running: bool,
    pub machines: Vec<Machine>,
    /// Loopback URL where the lab is reachable on this machine, once running (Docker labs
    /// with a published port). None for VM labs or when nothing is published yet.
    pub url: Option<String>,
}

fn validate_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(Error::Invalid(format!("invalid lab id `{id}`"))) }
}

fn lab_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    validate_id(id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Invalid(e.to_string()))?
        .join("labs")
        .join(id);
    if !dir.is_dir() {
        return Err(Error::Invalid(format!("lab `{id}` is not installed")));
    }
    Ok(dir)
}

/// Starts an installed lab. `provider` is required for VM labs (the Vagrant
/// provider to use) and ignored for Docker labs; `env` is passed to the runtime.
pub async fn start(
    dir: &Path,
    id: &str,
    runtime: Runtime,
    provider: Option<providers::Provider>,
    env: &[(String, String)],
    log: impl FnMut(String),
) -> Result<()> {
    match runtime {
        Runtime::Docker => docker::start(dir, id, env, log).await,
        Runtime::Vm => {
            let provider = provider.ok_or_else(|| Error::Invalid("VM labs need a provider".into()))?;
            vm::start(dir, provider, env, log).await
        }
    }
}

/// Where a running lab is reachable on this machine (its first published port). None for
/// VM labs (their address is discovered differently) or when nothing is published.
pub async fn primary_url(dir: &Path, id: &str, runtime: Runtime) -> Option<String> {
    match runtime {
        Runtime::Docker => docker::primary_url(dir, id).await,
        Runtime::Vm => None,
    }
}

/// Starts an installed lab without a launch token: it uses its development
/// evidence. Players go through `labs::lab_launch` instead.
#[tauri::command]
pub async fn lab_start(
    app: AppHandle,
    id: String,
    runtime: Runtime,
    provider: Option<providers::Provider>,
    logs: Channel<String>,
) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    let log = move |line: String| {
        let _ = logs.send(line);
    };
    start(&dir, &id, runtime, provider, &[], log).await
}

#[tauri::command]
pub async fn lab_stop(app: AppHandle, id: String, runtime: Runtime, logs: Channel<String>) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    let log = move |line: String| {
        let _ = logs.send(line);
    };
    match runtime {
        Runtime::Docker => docker::stop(&dir, &id, log).await,
        Runtime::Vm => vm::stop(&dir, log).await,
    }
}

#[tauri::command]
pub async fn lab_status(app: AppHandle, id: String, runtime: Runtime) -> Result<LabStatus> {
    let dir = lab_dir(&app, &id)?;
    match runtime {
        Runtime::Docker => docker::status(&dir, &id).await,
        Runtime::Vm => vm::status(&dir).await,
    }
}

#[cfg(test)]
mod tests {
    use super::validate_id;

    #[test]
    fn rejects_path_traversal_and_shell_characters() {
        for bad in ["", "../x", "a/b", "a b", "a;rm", "é", &"x".repeat(65)] {
            assert!(validate_id(bad).is_err(), "{bad:?} should be rejected");
        }
        for good in ["web-1", "sqli_basic", "3f2a9c1e-7b1d-4c4e-9a53-2d1c8f0e6b7a"] {
            assert!(validate_id(good).is_ok(), "{good:?} should be accepted");
        }
    }
}
