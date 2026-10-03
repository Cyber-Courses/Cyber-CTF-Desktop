//! Lab runtimes. A lab is a directory under `<app data>/labs/<lab id>/` holding
//! either a `docker-compose.yml` (Docker labs) or a `Vagrantfile` (VM labs).
//! The UI only ever passes a lab id and a runtime; paths and commands are built here.

mod docker;
mod exegol;
pub mod homelab;
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

/// A port the software inside a container binds: `target` is the port inside the
/// container, `published` is where it is reachable on 127.0.0.1 (0 = not published).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub published: u16,
    pub target: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// The container (a small computer on the lab network).
    pub name: String,
    pub state: String,
    /// The image = the software running inside the container, e.g. "mysql:8.0".
    #[serde(default)]
    pub image: String,
    /// The container's address on the lab network, e.g. "172.20.0.4" (empty if unknown).
    #[serde(default)]
    pub ip: String,
    /// Ports the software inside it binds (for the network diagram).
    #[serde(default)]
    pub ports: Vec<Port>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabStatus {
    pub running: bool,
    pub machines: Vec<Machine>,
    /// Loopback URL where the lab is reachable on this machine, once running (Docker labs
    /// with a published port). None for VM labs or when nothing is published yet.
    pub url: Option<String>,
    /// Name of the home-lab host a VM lab runs on; None when it runs on this machine.
    pub host: Option<String>,
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

/// Starts an installed lab; `env` is passed to the runtime. VM labs run either on this
/// machine with `provider` (a local Vagrant provider), or on the home-lab `host` (its
/// provider and connection env come from the host profile). Docker labs ignore both.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    app: &AppHandle,
    dir: &Path,
    id: &str,
    runtime: Runtime,
    provider: Option<providers::Provider>,
    host: Option<&str>,
    env: &[(String, String)],
    mut log: impl FnMut(String),
) -> Result<()> {
    match runtime {
        Runtime::Docker => docker::start(dir, id, env, log).await,
        Runtime::Vm => match host {
            Some(host) => {
                let conn = homelab::connection(app, host)?;
                // vagrant-proxmox (last release 2016) no longer installs on current Vagrant
                // (activesupport 4.0 vs Vagrant's i18n), so Proxmox needs its own driver.
                if conn.provider == providers::Provider::Proxmox {
                    return Err(Error::Invalid("Running labs on Proxmox isn't available yet: the Vagrant Proxmox plugin no longer works with current Vagrant. Use an ESXi host or this machine for now.".into()));
                }
                // Mark first, so a half-created lab can still be destroyed on the same host.
                homelab::mark_lab(dir, Some(host))?;
                log(format!("Running on home-lab host {} ({})", conn.name, conn.provider.id()));
                let env: Vec<(String, String)> = env.iter().cloned().chain(conn.env).collect();
                vm::start(dir, conn.provider, &env, log).await
            }
            None => {
                let provider = provider.ok_or_else(|| Error::Invalid("VM labs need a provider".into()))?;
                if provider.is_remote() {
                    return Err(Error::Invalid("pick a home-lab host to run on ESXi or Proxmox".into()));
                }
                homelab::mark_lab(dir, None)?;
                vm::start(dir, provider, env, log).await
            }
        },
    }
}

/// The env a VM lab's Vagrantfile needs to reach the host it runs on (empty if local),
/// plus that host's name.
fn vm_env(app: &AppHandle, dir: &Path) -> Result<(Vec<(String, String)>, Option<String>)> {
    Ok(match homelab::lab_connection(app, dir)? {
        Some(conn) => (conn.env, Some(conn.name)),
        None => (Vec::new(), None),
    })
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
    host: Option<String>,
    logs: Channel<String>,
) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    let log = move |line: String| {
        let _ = logs.send(line);
    };
    start(&app, &dir, &id, runtime, provider, host.as_deref(), &[], log).await
}

#[tauri::command]
pub async fn lab_stop(app: AppHandle, id: String, runtime: Runtime, logs: Channel<String>) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    let log = move |line: String| {
        let _ = logs.send(line);
    };
    match runtime {
        Runtime::Docker => docker::stop(&dir, &id, log).await,
        Runtime::Vm => vm::stop(&dir, &vm_env(&app, &dir)?.0, log).await,
    }
}

#[tauri::command]
pub async fn lab_status(app: AppHandle, id: String, runtime: Runtime) -> Result<LabStatus> {
    let dir = lab_dir(&app, &id)?;
    match runtime {
        Runtime::Docker => docker::status(&dir, &id).await,
        Runtime::Vm => {
            let (env, host) = vm_env(&app, &dir)?;
            Ok(LabStatus { host, ..vm::status(&dir, &env).await? })
        }
    }
}

/// Status of a lab's attack box (Exegol), for the lab detail view.
#[tauri::command]
pub async fn exegol_status(id: String, image: String) -> Result<exegol::ExegolStatus> {
    validate_id(&id)?;
    if !exegol::valid_image(&image) {
        return Err(Error::Invalid(format!("invalid attack-box image `{image}`")));
    }
    Ok(exegol::status(&id, &image).await)
}

/// Launches the attack box on the lab's network (pulls the image first if needed).
#[tauri::command]
pub async fn exegol_start(id: String, image: String, logs: Channel<String>) -> Result<()> {
    validate_id(&id)?;
    if !exegol::valid_image(&image) {
        return Err(Error::Invalid(format!("invalid attack-box image `{image}`")));
    }
    let log = move |line: String| {
        let _ = logs.send(line);
    };
    exegol::start(&id, &image, log).await
}

#[tauri::command]
pub async fn exegol_stop(id: String, logs: Channel<String>) -> Result<()> {
    validate_id(&id)?;
    let log = move |line: String| {
        let _ = logs.send(line);
    };
    exegol::stop(&id, log).await
}

/// Opens the player's terminal attached to the running attack box.
#[tauri::command]
pub fn exegol_shell(id: String) -> Result<()> {
    validate_id(&id)?;
    exegol::shell(&id)
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
