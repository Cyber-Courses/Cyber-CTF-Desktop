//! Lab runtimes. A lab is a directory under `<app data>/labs/<lab id>/` with an `isoloom.yml`
//! at its root; the files of the target it runs on are generated under its `.isoloom/` (see
//! `lab`). The UI only ever passes a lab id and a runtime; paths and commands are built here.

mod docker;
mod exegol;
pub mod lab;
mod model;
pub mod providers;
mod proxmox;
pub mod server;
pub mod server_selftest;
mod ssh;
mod terraform;
mod vm;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

pub use model::{Interface, LabStatus, Machine, Network, Place, Port, Service};

/// Mirrors `LabRuntime` in CyberBackend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Runtime {
    Docker,
    Vm,
}

fn validate_id(id: &str) -> Result<()> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(Error::Invalid(format!("invalid lab id `{id}`"))) }
}

fn lab_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    validate_id(id)?;
    let dir = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("labs").join(id);
    if !dir.is_dir() {
        return Err(Error::Invalid(format!("lab `{id}` is not installed")));
    }
    Ok(dir)
}

/// One operation per lab at a time: start, stop and the expiry reaper all take this per-lab
/// lock, so a user Start/Stop and the reaper can't run two Terraform (or Vagrant) operations
/// over the same state at once, which could corrupt `terraform.tfstate`.
fn lab_lock(id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map.lock().expect("lab lock registry");
    map.entry(id.to_string()).or_default().clone()
}

/// Starts an installed lab; `env` is passed to the runtime (evidence claim, attack box).
///
/// - No `host`: Docker labs run on this machine's Docker, or in one VM on this machine with a
///   local `provider` (Isoloom's docker-vm); VM labs run one VM per machine (Isoloom's vagrant).
/// - With a server `host`: the lab runs there. ESXi runs the same Vagrantfiles; Proxmox and
///   the clouds run Isoloom's Terraform (Docker on one VM, or one VM per machine on Proxmox).
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
    let lock = lab_lock(id);
    let _guard = lock.lock().await;
    let Some(host) = host else {
        server::mark_lab(dir, None)?;
        // A lab runs in one place at a time: if it's already up here, refuse (a second copy
        // collides on its published host ports); if an earlier start left stopped or partial
        // infrastructure behind, clear it so this start is clean.
        ensure_local_slot_free(dir, id, &mut log).await?;
        return match runtime {
            // A container lab in a VM on this machine: Isoloom's docker-vm (Docker on one VM), with
            // the attack box next to it inside the VM (the lab network isn't reachable from here).
            Runtime::Docker if provider.is_some_and(|p| !p.is_remote()) => {
                let provider = provider.unwrap_or(providers::Provider::Virtualbox);
                let spec = lab::prepare(dir, lab::vagrant_target(runtime))?;
                mark_local_vm(dir, Some(provider))?;
                log(format!("Running in a {} VM on this machine", provider.id()));
                let vagrant = lab::vagrant_dir(dir, runtime);
                start_local_vm(&vagrant, provider, env, &mut log).await?;
                attack_box_vagrant(&vagrant, &spec, env, &mut log).await
            }
            Runtime::Docker => {
                lab::prepare(dir, isoloom_core::Target::Docker)?;
                mark_local_vm(dir, None)?;
                docker::start(dir, id, env, log).await?;
                exegol::rejoin(id).await;
                Ok(())
            }
            Runtime::Vm => {
                let provider = provider.ok_or_else(|| Error::Invalid("VM labs need a provider".into()))?;
                if provider.is_remote() {
                    return Err(Error::Invalid("pick a server host to run on ESXi or Proxmox".into()));
                }
                lab::prepare(dir, lab::vagrant_target(runtime))?;
                start_local_vm(&lab::vagrant_dir(dir, runtime), provider, env, &mut log).await
            }
        };
    };

    // GCP labs run in the account's labs project: make sure it exists (one free billing slot).
    if server::connection(app, host)?.provider == providers::Provider::Gcp {
        log("Checking the Cyber CTF labs project on Google Cloud…".into());
        server::gcp::labs_project(app, host).await?;
    }
    let conn = server::connection(app, host)?;
    // Mark first, so a half-created lab can still be destroyed on the same host.
    server::mark_lab(dir, Some(host))?;
    log(format!("Running on server host {} ({})", conn.name, conn.provider.id()));
    match conn.provider {
        provider if server::terraform_target(provider).is_some() => {
            let tf = server::terraform_target(provider).unwrap_or_default();
            let (module, target) = lab::terraform(dir, runtime, tf)?;
            let spec = lab::prepare(dir, target)?;
            let mut vars = conn.tf_vars.clone();
            if let Some(inputs) = lab::inputs_json(&spec, env) {
                vars.push(("inputs".into(), inputs));
            }
            // The launcher's key: Terraform copies the lab over SSH with it, and "Open shell"
            // reaches the attack box on the lab host.
            let (key, public) = ssh::ensure_key(app).await?;
            vars.push(("ssh_public_key".into(), public));
            vars.push(("ssh_private_key_file".into(), key.to_string_lossy().to_string()));
            if provider.is_cloud() {
                // Every cloud firewall opens SSH and the published ports to this machine's
                // public IP only.
                vars.push(("allowed_cidr".into(), format!("{}/32", public_ip().await?)));
            }
            if provider == providers::Provider::Aws {
                // Stop before spending if this account is over its monthly budget, or if a budget
                // is set and the spend is over it (AWS only); if the spend can't be read, warn
                // and launch anyway (below).
                match server::check_budget(app, host).await {
                    server::BudgetCheck::Over(spent, limit) => {
                        return Err(Error::Invalid(format!(
                            "Monthly budget reached for this account: ${spent:.2} of ${limit:.2} spent this month. Raise the budget in the account settings, or wait until next month."
                        )));
                    }
                    // Best effort: if the spend can't be read (Cost Explorer off, expired session,
                    // Docker/CLI missing), note it and launch anyway. The lab still auto-stops, so
                    // cost is bounded; blocking every launch over this would be too aggressive.
                    server::BudgetCheck::Unverifiable(why) => {
                        log(format!("Monthly budget not checked: {why} Launching anyway; the lab still auto-stops."));
                    }
                    server::BudgetCheck::Ok => {}
                }
            }
            if provider.is_cloud() {
                log(format!("This lab runs in your {} account and is billed there until you stop it.", conn.provider.id().to_uppercase()));
            }
            let state = state_dir(app, id, tf)?;
            // Which output ran (containers or one VM per machine), for the auto-stop reaper.
            std::fs::create_dir_all(&state)?;
            std::fs::write(state.join(RUNTIME_FILE), if runtime == Runtime::Vm { "VM" } else { "DOCKER" })?;
            terraform::apply(&module, &state, &vars, &conn.tf_env, &mut log).await?;
            if runtime == Runtime::Docker {
                attack_box_remote(app, id, &spec, env, &mut log).await?;
            }
            Ok(())
        }
        // ESXi: the same Vagrantfiles as on this machine, with the vmware_esxi provider.
        provider => {
            let spec = lab::prepare(dir, lab::vagrant_target(runtime))?;
            let env: Vec<(String, String)> = env.iter().cloned().chain(conn.env).collect();
            let vagrant = lab::vagrant_dir(dir, runtime);
            // Switched here from a local (or other) provider: clear the stale state first, so the
            // ESXi start doesn't refuse with "an active machine was found with a different provider".
            vm::reconcile_provider(&vagrant, provider, &env, &mut log).await;
            vm::start(&vagrant, provider, &env, &mut log).await?;
            if runtime == Runtime::Docker {
                attack_box_vagrant(&vagrant, &spec, &env, &mut log).await?;
            }
            Ok(())
        }
    }
}

/// Marks a container lab as running in a VM on this machine (Isoloom's docker-vm),
/// so stop, status and the attack-box shell go to the VM instead of local Docker.
pub const LOCAL_VM_MARKER: &str = ".cyberctf-local-vm";

/// Guards a local start: refuses when the lab is already running on this machine (Docker or a
/// local VM), and otherwise tears down any stopped or half-created leftovers from a previous
/// start so the fresh start doesn't trip over them (a poweroff VM, dead containers).
/// Starts local VMs with one automatic recovery. A `vagrant up` can fail because a crashed or
/// interrupted previous run left state behind that `ensure_local_slot_free` couldn't see: an
/// orphaned hypervisor VM (VirtualBox "VERR_ALREADY_EXISTS") or a stale lock ("the machine is
/// locked"). When the failure is one of those, clear the leftovers and try once more; a genuine
/// provisioning failure is returned unchanged, never retried.
async fn start_local_vm(dir: &Path, provider: providers::Provider, env: &[(String, String)], log: &mut impl FnMut(String)) -> Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    // A missing hypervisor or Vagrant plugin should say so plainly, not fail mid-boot with a
    // raw Vagrant error.
    providers::ensure_usable(provider).await.map_err(Error::Invalid)?;
    // Switched target since last time (e.g. an ESXi run, now local): clear the old state so
    // `vagrant up` doesn't refuse with "an active machine was found with a different provider".
    vm::reconcile_provider(dir, provider, env, log).await;
    let stale = AtomicBool::new(false);
    let first = {
        let out = &mut *log;
        vm::start(dir, provider, env, |l: String| {
            if vm::is_stale_state_error(&l) {
                stale.store(true, Ordering::Relaxed);
            }
            out(l);
        })
        .await
    };
    match first {
        Ok(()) => Ok(()),
        Err(_) if stale.load(Ordering::Relaxed) => {
            log("A previous run left VM state behind. Clearing it, then starting again…".into());
            vm::recover_local(dir, provider, log).await;
            vm::start(dir, provider, env, log).await
        }
        Err(e) => Err(e),
    }
}

async fn ensure_local_slot_free(dir: &Path, id: &str, log: &mut impl FnMut(String)) -> Result<()> {
    // Docker containers of this lab on this machine (best effort: before the first start the
    // compose file may not exist yet, and status then errors, which just means nothing to clear).
    if let Ok(s) = docker::status(dir, id).await {
        if s.running {
            return Err(Error::Invalid("This lab is already running on this machine. Stop it before starting it again.".into()));
        }
        if !s.machines.is_empty() {
            log("Clearing a previous, stopped run…".into());
            let _ = docker::stop(dir, id, |_l: String| {}).await;
        }
    }
    // A local VM for this lab (Docker on one VM, or a VM lab), whichever vagrant folder holds one.
    for rt in [Runtime::Docker, Runtime::Vm] {
        let vdir = lab::vagrant_dir(dir, rt);
        if !vdir.join("Vagrantfile").exists() {
            continue;
        }
        let Ok(s) = vm::status(&vdir, &[]).await else { continue };
        if s.running {
            return Err(Error::Invalid("This lab is already running in a VM on this machine. Stop it before starting it again.".into()));
        }
        // "not_created" is a clean slate; anything else (poweroff, aborted, saved) is a leftover.
        if s.machines.iter().any(|m| m.state != "not_created") {
            log("Clearing a previous, incomplete VM…".into());
            let _ = vm::stop(&vdir, &[], |_l: String| {}).await;
        }
    }
    Ok(())
}

fn mark_local_vm(dir: &Path, provider: Option<providers::Provider>) -> Result<()> {
    match provider {
        Some(p) => std::fs::write(dir.join(LOCAL_VM_MARKER), p.id())?,
        None => {
            let _ = std::fs::remove_file(dir.join(LOCAL_VM_MARKER));
        }
    }
    Ok(())
}

/// The hypervisor a container lab runs on in a local VM, if it does.
fn local_vm(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(LOCAL_VM_MARKER)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn vm_label(provider: &str) -> &str {
    match provider {
        "virtualbox" => "VirtualBox",
        "vmware_desktop" => "VMware",
        "parallels" => "Parallels",
        "hyperv" => "Hyper-V",
        "libvirt" => "libvirt",
        other => other,
    }
}

/// The attack-box image the player picked, when one was (passed in the run env).
fn attack_box_image(env: &[(String, String)]) -> Option<&str> {
    env.iter().find(|(k, _)| k == "CYBERCTF_ATTACKBOX_IMAGE").map(|(_, v)| v.as_str()).filter(|i| exegol::valid_image(i))
}

/// Starts the attack box on a lab host running the lab's Compose file: a container named
/// `attacker` on every network of the Compose project (the spec's name), so segmented labs
/// are reachable from it. The lab network isn't reachable from this machine, so the player's
/// shell goes over SSH into this container.
fn attack_box_script(project: &str, image: &str) -> String {
    format!(
        "set -euo pipefail\ndocker rm -f attacker >/dev/null 2>&1 || true\nmapfile -t networks < <(docker network ls -q --filter label=com.docker.compose.project={project})\n[ -n \"${{networks[*]:-}}\" ] || {{ echo 'the lab has no network' >&2; exit 1; }}\ndocker pull -q {image} >/dev/null\ndocker run -d --name attacker --hostname attacker --network \"${{networks[0]}}\" {image} sleep infinity >/dev/null\nfor n in \"${{networks[@]:1}}\"; do docker network connect \"$n\" attacker; done\n",
        project = ssh::sh_quote(project),
        image = ssh::sh_quote(image),
    )
}

/// The attack box on a Terraform lab host (server or cloud), over SSH with the launcher's key.
async fn attack_box_remote(app: &AppHandle, id: &str, spec: &isoloom_core::Spec, env: &[(String, String)], log: &mut impl FnMut(String)) -> Result<()> {
    let Some(image) = attack_box_image(env) else { return Ok(()) };
    let Some(conn) = server::lab_connection(app, &lab_dir(app, id)?)? else { return Ok(()) };
    let tf = server::terraform_target(conn.provider).unwrap_or_default();
    let state = state_dir(app, id, tf)?;
    let (host, user) = terraform::ssh_endpoint(&state).ok_or_else(|| Error::Invalid("the lab host has no address".into()))?;
    let target = ssh::Target { host, port: 22, user, identity: ssh::ensure_key(app).await?.0 };
    log("Starting the attack box next to the lab (this pulls its image the first time)…".into());
    let script = attack_box_script(&spec.name, image);
    target.exec(&state.join("known_hosts"), &format!("sudo bash -c {}", ssh::sh_quote(&script))).await?;
    log("Attack box ready.".into());
    Ok(())
}

/// The attack box in a local or ESXi lab VM (Docker on one VM), through `vagrant ssh`.
async fn attack_box_vagrant(vagrant: &Path, spec: &isoloom_core::Spec, env: &[(String, String)], log: &mut impl FnMut(String)) -> Result<()> {
    let Some(image) = attack_box_image(env) else { return Ok(()) };
    log("Starting the attack box next to the lab (this pulls its image the first time)…".into());
    let command = format!("sudo bash -c {}", ssh::sh_quote(&attack_box_script(&spec.name, image)));
    crate::exec::run_env("vagrant", &["ssh", "-c", &command], Some(vagrant), env).await?;
    log("Attack box ready.".into());
    Ok(())
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

/// Next to a lab's Terraform state: which runtime started it (`DOCKER` or `VM`).
const RUNTIME_FILE: &str = "runtime";

/// Terraform state for a lab's target, outside the lab folder.
fn state_dir(app: &AppHandle, id: &str, target: &str) -> Result<PathBuf> {
    validate_id(id)?;
    Ok(app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("deployments").join(id).join(target))
}

/// Stops a lab wherever it runs, destroying remote VMs so the next start is clean.
async fn stop(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, log: impl FnMut(String)) -> Result<()> {
    let lock = lab_lock(id);
    let _guard = lock.lock().await;
    stop_locked(app, dir, id, runtime, log).await
}

/// The body of `stop`, assuming the caller already holds the lab lock. The reaper uses this so
/// it can re-check expiry under the same lock before tearing a lab down (the tokio lock is not
/// reentrant, so it must not call `stop`, which would deadlock).
async fn stop_locked(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, log: impl FnMut(String)) -> Result<()> {
    let conn = server::lab_connection(app, dir)?;
    let result = match (runtime, conn) {
        (Runtime::Docker, None) if local_vm(dir).is_some() => vm::stop(&lab::vagrant_dir(dir, runtime), &[], log).await,
        (Runtime::Docker, None) => docker::stop(dir, id, log).await,
        (Runtime::Vm, None) => vm::stop(&lab::vagrant_dir(dir, runtime), &[], log).await,
        (_, Some(c)) if server::terraform_target(c.provider).is_some() => {
            let tf = server::terraform_target(c.provider).unwrap_or_default();
            let module = lab::terraform_to_destroy(dir, runtime, tf)?;
            terraform::destroy(&module, &state_dir(app, id, tf)?, &c.tf_vars, &c.tf_env, log).await
        }
        (_, Some(c)) => vm::stop(&lab::vagrant_dir(dir, runtime), &c.env, log).await,
    };
    if result.is_ok() {
        server::mark_lab(dir, None)?;
        mark_local_vm(dir, None)?;
    }
    result
}

async fn status(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime) -> Result<LabStatus> {
    let Some(c) = server::lab_connection(app, dir)? else {
        return match runtime {
            // Shown like a remote lab (the attack box lives in the VM, reached over SSH).
            Runtime::Docker if let Some(p) = local_vm(dir) => {
                let status = vm::status(&lab::vagrant_dir(dir, runtime), &[]).await?;
                Ok(LabStatus { host: Some(format!("{} VM on this machine", vm_label(&p))), place: Some(Place::LocalVm), ..status })
            }
            Runtime::Docker => Ok(LabStatus { place: Some(Place::Container), ..docker::status(dir, id).await? }),
            Runtime::Vm => Ok(LabStatus { place: Some(Place::LocalVm), ..vm::status(&lab::vagrant_dir(dir, runtime), &[]).await? }),
        };
    };
    let status = match server::terraform_target(c.provider) {
        Some(tf) => terraform::status(&state_dir(app, id, tf)?),
        None => vm::status(&lab::vagrant_dir(dir, runtime), &c.env).await?,
    };
    let place = if c.provider.is_cloud() { Place::Cloud } else { Place::Server };
    Ok(LabStatus { host: Some(c.name), place: Some(place), ..status })
}

/// Destroys cloud labs whose auto-stop time has passed, to end billing: on Azure an OS
/// poweroff only stops (not deallocates) the VM, so it keeps billing until a `destroy`, and a
/// destroy also cleans up leftover resources on every cloud. Runs on startup and periodically
/// while the app is open; a lab that expired while the app was closed is reaped at the next sweep.
pub async fn reap_expired_labs(app: &AppHandle) {
    let Ok(base) = app.path().app_data_dir() else { return };
    let Ok(entries) = std::fs::read_dir(base.join("deployments")) else { return };
    let ids: Vec<String> = entries.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|id| validate_id(id).is_ok()).collect();
    for id in ids {
        let Ok(dir) = lab_dir(app, &id) else { continue };
        let Ok(Some(c)) = server::lab_connection(app, &dir) else { continue };
        let Some(target) = server::terraform_target(c.provider) else { continue };
        let Ok(state) = state_dir(app, &id, target) else { continue };
        if !terraform::expired(&state) {
            continue;
        }
        // Take the lab lock before tearing it down, and re-check expiry while holding it: between
        // the cheap filter above and here a user may have restarted or extended this lab (a start
        // re-applies and writes a fresh expiry), and destroying their live lab would be wrong.
        let lock = lab_lock(&id);
        let _guard = lock.lock().await;
        if !terraform::expired(&state) {
            continue;
        }
        // Best effort: tear it down to end billing. No UI context here, so logs are dropped;
        // if the destroy fails, the next sweep retries.
        // Recorded at start: containers on one VM, or one VM per machine.
        let runtime = match std::fs::read_to_string(state.join(RUNTIME_FILE)).as_deref().map(str::trim) {
            Ok("VM") => Runtime::Vm,
            _ => Runtime::Docker,
        };
        let _ = stop_locked(app, &dir, &id, runtime, |_line: String| {}).await;
    }
}

/// Where a running lab is reachable on this machine (its first published port). None for
/// VM labs (their address is discovered differently) or when nothing is published.
pub async fn primary_url(dir: &Path, id: &str, runtime: Runtime) -> Option<String> {
    match runtime {
        Runtime::Docker if !dir.join(".cyberctf-host").exists() && local_vm(dir).is_none() => docker::primary_url(dir, id).await,
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

/// Runs a lab's exploitability check: does the intended exploit path still work? Lets a
/// learner who broke their box know to reset it. Local Docker labs only for now.
#[tauri::command]
pub async fn lab_check(app: AppHandle, id: String, runtime: Runtime) -> Result<docker::Check> {
    let dir = lab_dir(&app, &id)?;
    match runtime {
        Runtime::Docker if server::lab_connection(&app, &dir)?.is_none() => docker::check(&dir, &id).await,
        _ => Ok(docker::Check { available: false, ok: false, output: String::new() }),
    }
}

/// Opens the attack box shell of a running lab, wherever it runs: the local container,
/// or over SSH on the lab host of a remote lab (server / cloud).
#[tauri::command]
pub async fn lab_attack_shell(app: AppHandle, id: String, runtime: Runtime) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    let Some(conn) = server::lab_connection(&app, &dir)? else {
        if local_vm(&dir).is_some() && matches!(runtime, Runtime::Docker) {
            let out = crate::exec::run_env("vagrant", &["ssh-config"], Some(&lab::vagrant_dir(&dir, runtime)), &[]).await?;
            let target = ssh::parse_ssh_config(&out).ok_or_else(|| Error::Invalid("couldn't read the lab VM's SSH settings".into()))?;
            return exegol::open_terminal(&target.attack_shell_command(&ssh::known_hosts(&app)?)?);
        }
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
        let out = crate::exec::run_env("vagrant", &["ssh-config"], Some(&lab::vagrant_dir(&dir, runtime)), &conn.env).await?;
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
    use super::{local_vm, mark_local_vm, providers::Provider, validate_id};

    /// A real lab through the launcher's Docker path (opt-in, needs Docker):
    ///   CYBERCTF_TEST_LAB=~/code/invoice-portal-api cargo test docker_lab_end_to_end -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn docker_lab_end_to_end() {
        let src = std::path::PathBuf::from(std::env::var("CYBERCTF_TEST_LAB").expect("CYBERCTF_TEST_LAB"));
        let dir = std::env::temp_dir().join(format!("cyberctf-e2e-{}", rand::random::<u32>()));
        assert!(std::process::Command::new("cp").arg("-R").arg(&src).arg(&dir).status().unwrap().success());
        let _ = std::fs::remove_dir_all(dir.join(".isoloom"));
        let id = "e2e-test";
        super::lab::prepare(&dir, isoloom_core::Target::Docker).expect("generate");
        let print = |l: String| println!("{l}");
        let started = super::docker::start(&dir, id, &[], print).await;
        let status = super::docker::status(&dir, id).await;
        let check = super::docker::check(&dir, id).await;
        super::docker::stop(&dir, id, print).await.expect("stop");
        let _ = std::fs::remove_dir_all(&dir);
        started.expect("start");
        let status = status.expect("status");
        assert!(status.running, "the lab should be running");
        let services: Vec<String> = status.machines.iter().flat_map(|m| m.services.iter().map(|s| format!("{}={}", s.name, s.kind))).collect();
        println!("services: {services:?}, url: {:?}", status.url);
        assert!(services.contains(&"portal=web".to_string()), "{services:?}");
        let check = check.expect("check");
        assert!(check.available && check.ok, "check: {}", check.output);
    }

    #[test]
    fn local_vm_marker_round_trips() {
        let dir = std::env::temp_dir().join(format!("cyberctf-localvm-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(local_vm(&dir), None);
        mark_local_vm(&dir, Some(Provider::Virtualbox)).unwrap();
        assert_eq!(local_vm(&dir).as_deref(), Some("virtualbox"));
        mark_local_vm(&dir, None).unwrap();
        assert_eq!(local_vm(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

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
