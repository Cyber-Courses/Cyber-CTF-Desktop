//! Lab runtimes. A lab is a directory under `<app data>/labs/<lab id>/` holding
//! either a `docker-compose.yml` (Docker labs) or a `Vagrantfile` (VM labs).
//! The UI only ever passes a lab id and a runtime; paths and commands are built here.

mod docker;
mod exegol;
pub mod server;
pub mod providers;
mod ssh;
mod terraform;
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
    /// Name of the server host a VM lab runs on; None when it runs on this machine.
    pub host: Option<String>,
    /// Unix time a cloud lab stops itself (auto-stop), if it does.
    pub expires_at: Option<u64>,
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

/// Starts an installed lab; `env` is passed to the runtime (evidence claim, attack box).
///
/// - No `host`: Docker labs run on this machine; VM labs run their root Vagrantfile with
///   the local `provider`.
/// - With a server `host`: the lab runs there. A Docker lab is deployed through its
///   `deploy/` layer onto a lab host VM (ESXi: `deploy/vagrant`, Proxmox:
///   `deploy/terraform/proxmox`); a VM lab runs its root Vagrantfile on ESXi.
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
    let Some(host) = host else {
        server::mark_lab(dir, None)?;
        return match runtime {
            Runtime::Docker => docker::start(dir, id, env, log).await,
            Runtime::Vm => {
                let provider = provider.ok_or_else(|| Error::Invalid("VM labs need a provider".into()))?;
                if provider.is_remote() {
                    return Err(Error::Invalid("pick a server host to run on ESXi or Proxmox".into()));
                }
                vm::start(dir, provider, env, log).await
            }
        };
    };

    let conn = server::connection(app, host)?;
    // Mark first, so a half-created lab can still be destroyed on the same host.
    server::mark_lab(dir, Some(host))?;
    log(format!("Running on server host {} ({})", conn.name, conn.provider.id()));
    match (runtime, conn.provider) {
        (Runtime::Docker, provider) if server::terraform_target(provider).is_some() => {
            let target = server::terraform_target(provider).unwrap_or_default();
            let mut vars = conn.tf_vars.clone();
            vars.extend(lab_vars(dir, id, env)?);
            // The launcher's key, so "Open shell" can reach the attack box on the lab host.
            vars.push(("ssh_public_key".into(), ssh::ensure_key(app).await?.1));
            if provider == providers::Provider::Aws {
                // SSH open to this machine's public IP only.
                vars.push(("allowed_cidr".into(), format!("{}/32", public_ip().await?)));
                log("This lab runs in your AWS account and is billed there until you stop it.".into());
            }
            terraform::apply(&dir.join("deploy"), &state_dir(app, id, target)?, target, &vars, &conn.tf_env, log).await
        }
        (Runtime::Docker, provider) => {
            let vagrant = dir.join("deploy").join("vagrant");
            if !vagrant.join("Vagrantfile").is_file() {
                return Err(Error::Invalid("this lab can't run on a server host yet (no deploy/vagrant)".into()));
            }
            let env: Vec<(String, String)> = env.iter().cloned().chain(conn.env).collect();
            vm::start(&vagrant, provider, &env, log).await
        }
        // vagrant-proxmox (last release 2016) no longer installs on current Vagrant, and
        // multi-VM labs don't have a Terraform module yet.
        (Runtime::Vm, providers::Provider::Proxmox | providers::Provider::Aws) => {
            Err(Error::Invalid("This VM lab can only run on this machine or an ESXi host for now.".into()))
        }
        (Runtime::Vm, provider) => {
            let env: Vec<(String, String)> = env.iter().cloned().chain(conn.env).collect();
            vm::start(dir, provider, &env, log).await
        }
    }
}

/// Terraform's lab variables: what to fetch (repository @ commit, recorded at install)
/// and the run env (evidence claim, attack box).
fn lab_vars(dir: &Path, id: &str, env: &[(String, String)]) -> Result<Vec<(String, String)>> {
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).map(|s| s.trim().to_string()).ok().filter(|s| !s.is_empty());
    let (Some(repository), Some(commit)) = (read(".cyberctf-repository"), read(".cyberctf-commit")) else {
        return Err(Error::Invalid("launch this lab once from the catalogue so the launcher knows its source".into()));
    };
    let mut vars = vec![("lab_slug".to_string(), id.to_string()), ("lab_repository".into(), repository), ("lab_commit".into(), commit)];
    for (name, var) in [("CTF_API_URL", "ctf_api_url"), ("CTF_LAUNCH_TOKEN", "ctf_launch_token"), ("CYBERCTF_ATTACKBOX_IMAGE", "attackbox_image")] {
        if let Some((_, v)) = env.iter().find(|(k, _)| k == name) {
            vars.push((var.to_string(), v.clone()));
        }
    }
    Ok(vars)
}

/// This machine's public IPv4, for cloud firewall rules.
async fn public_ip() -> Result<String> {
    let ip = reqwest::get("https://checkip.amazonaws.com")
        .await
        .map_err(|e| Error::Invalid(format!("couldn't find this machine's public IP: {e}")))?
        .text()
        .await
        .map_err(|e| Error::Invalid(format!("couldn't find this machine's public IP: {e}")))?;
    let ip = ip.trim();
    ip.parse::<std::net::Ipv4Addr>().map_err(|_| Error::Invalid("unexpected public IP answer".into()))?;
    Ok(ip.to_string())
}

/// Terraform state for a lab's target, outside the lab folder.
fn state_dir(app: &AppHandle, id: &str, target: &str) -> Result<PathBuf> {
    validate_id(id)?;
    Ok(app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("deployments").join(id).join(target))
}

/// Stops a lab wherever it runs, destroying remote VMs so the next start is clean.
async fn stop(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, log: impl FnMut(String)) -> Result<()> {
    let conn = server::lab_connection(app, dir)?;
    let result = match (runtime, conn) {
        (Runtime::Docker, None) => docker::stop(dir, id, log).await,
        (Runtime::Vm, None) => vm::stop(dir, &[], log).await,
        (Runtime::Docker, Some(c)) if server::terraform_target(c.provider).is_some() => {
            let target = server::terraform_target(c.provider).unwrap_or_default();
            terraform::destroy(&dir.join("deploy"), &state_dir(app, id, target)?, target, &c.tf_vars, &c.tf_env, log).await
        }
        (Runtime::Docker, Some(c)) => vm::stop(&dir.join("deploy").join("vagrant"), &c.env, log).await,
        (Runtime::Vm, Some(c)) => vm::stop(dir, &c.env, log).await,
    };
    if result.is_ok() {
        server::mark_lab(dir, None)?;
    }
    result
}

async fn status(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime) -> Result<LabStatus> {
    let Some(c) = server::lab_connection(app, dir)? else {
        return match runtime {
            Runtime::Docker => docker::status(dir, id).await,
            Runtime::Vm => vm::status(dir, &[]).await,
        };
    };
    let status = match runtime {
        Runtime::Docker if server::terraform_target(c.provider).is_some() => {
            terraform::status(&state_dir(app, id, server::terraform_target(c.provider).unwrap_or_default())?)
        }
        Runtime::Docker => vm::status(&dir.join("deploy").join("vagrant"), &c.env).await?,
        Runtime::Vm => vm::status(dir, &c.env).await?,
    };
    Ok(LabStatus { host: Some(c.name), ..status })
}

/// Where a running lab is reachable on this machine (its first published port). None for
/// VM labs (their address is discovered differently) or when nothing is published.
pub async fn primary_url(dir: &Path, id: &str, runtime: Runtime) -> Option<String> {
    match runtime {
        Runtime::Docker if !dir.join(".cyberctf-host").exists() => docker::primary_url(dir, id).await,
        _ => None,
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
    stop(&app, &dir, &id, runtime, log).await
}

#[tauri::command]
pub async fn lab_status(app: AppHandle, id: String, runtime: Runtime) -> Result<LabStatus> {
    let dir = lab_dir(&app, &id)?;
    status(&app, &dir, &id, runtime).await
}

/// Opens the attack box shell of a running lab, wherever it runs: the local container,
/// or over SSH on the lab host of a remote lab (server / cloud).
#[tauri::command]
pub async fn lab_attack_shell(app: AppHandle, id: String, runtime: Runtime) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    let Some(conn) = server::lab_connection(&app, &dir)? else {
        return exegol::shell(&id);
    };
    if !matches!(runtime, Runtime::Docker) {
        return Err(Error::Invalid("this lab has no attack box".into()));
    }
    let target = if let Some(tf) = server::terraform_target(conn.provider) {
        let (host, user) = terraform::ssh_endpoint(&state_dir(&app, &id, tf)?)
            .ok_or_else(|| Error::Invalid("the lab host has no address yet; wait for it to finish starting".into()))?;
        ssh::Target { host, port: 22, user, identity: ssh::ensure_key(&app).await?.0 }
    } else {
        let out = crate::exec::run_env("vagrant", &["ssh-config"], Some(&dir.join("deploy").join("vagrant")), &conn.env).await?;
        ssh::parse_ssh_config(&out).ok_or_else(|| Error::Invalid("couldn't read the lab host's SSH settings".into()))?
    };
    exegol::open_terminal(&target.attack_shell_command(&ssh::known_hosts(&app)?)?)
}

/// An attack-box image reference the launcher accepts.
pub fn valid_image(image: &str) -> bool {
    exegol::valid_image(image)
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
