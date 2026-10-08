//! Lab runtimes. A lab is a directory under `<app data>/labs/<lab id>/` with an `isoloom.yml`
//! at its root; the files of the target it runs on are generated under its `.isoloom/` (see
//! `lab`). The UI only ever passes a lab id and a runtime; paths and commands are built here.

mod attack_vm;
mod discover;
mod docker;
pub use docker::subnets_in_use;
mod exegol;
pub mod lab;
mod model;
pub mod providers;
mod proxmox;
mod registry;
pub mod server;
pub mod server_selftest;
mod ssh;
mod terraform;
mod vm;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// The labs with a start/stop operation provisioning right now, each with its in-flight count (a
/// lab can be re-entered). The app reads this to warn before quitting mid-deploy (interrupting a
/// cloud `terraform apply` leaves billable resources behind, a VM/Docker run half-created), and
/// the UI reads it to rehydrate the "this lab is starting" state after a window reload: the map
/// lives in this long-lived process, so a reloaded webview that lost its own deploy state can ask
/// which labs are still deploying and show that instead of a bare Start button.
fn deploying() -> &'static Mutex<HashMap<String, (Action, usize)>> {
    static D: OnceLock<Mutex<HashMap<String, (Action, usize)>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What is in flight for a lab: a start (provisioning) or a stop (teardown). Told apart so the
/// UI never calls a lab being stopped "deploying".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Start,
    Stop,
    /// Pausing or shutting the lab down, machines kept: neither a deploy nor a teardown.
    Park,
}

/// Total start/stop operations in flight, across all labs.
pub fn active_deploys() -> usize {
    deploying().lock().map(|m| m.values().map(|(_, n)| n).sum()).unwrap_or(0)
}

/// The labs being started right now (in this process), deduplicated.
pub fn deploying_labs() -> Vec<String> {
    labs_with(Action::Start)
}

/// The labs being stopped right now (in this process), deduplicated.
pub fn stopping_labs() -> Vec<String> {
    labs_with(Action::Stop)
}

/// The labs being paused or shut down right now (in this process), deduplicated.
pub fn parking_labs() -> Vec<String> {
    labs_with(Action::Park)
}

/// Every in-process operation right now: the lab and what it is doing.
pub fn active_actions() -> Vec<(String, Action)> {
    deploying().lock().map(|m| m.iter().map(|(id, (a, _))| (id.clone(), *a)).collect()).unwrap_or_default()
}

fn labs_with(action: Action) -> Vec<String> {
    deploying().lock().map(|m| m.iter().filter(|(_, (a, _))| *a == action).map(|(id, _)| id.clone()).collect()).unwrap_or_default()
}

/// Marks its lab as starting or stopping for as long as it is alive (RAII), so the mark is always
/// cleared even if the operation errors or is cancelled.
struct DeployGuard(String);

impl DeployGuard {
    fn new(id: &str, action: Action) -> Self {
        if let Ok(mut m) = deploying().lock() {
            let e = m.entry(id.to_string()).or_insert((action, 0));
            // The latest operation names the state (a stop right after a start is "stopping").
            e.0 = action;
            e.1 += 1;
        }
        Self(id.to_string())
    }
}

impl Drop for DeployGuard {
    fn drop(&mut self) {
        let Ok(mut m) = deploying().lock() else { return };
        if let Some((_, c)) = m.get_mut(&self.0) {
            *c -= 1;
            if *c == 0 {
                m.remove(&self.0);
            }
        }
    }
}

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

pub use model::{Interface, LabStatus, Machine, Network, Park, Place, Port, Service};

/// Mirrors `LabRuntime` in CyberBackend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Runtime {
    Docker,
    Vm,
}

pub fn validate_id(id: &str) -> Result<()> {
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
    let _deploy = DeployGuard::new(id, Action::Start);
    let Some(host) = host else {
        server::mark_lab(dir, None)?;
        // A parked lab (paused or shut down) is one the player wants back as it was, not rebuilt:
        // its stopped machines would otherwise read as leftovers and be cleared below.
        // Unless nothing of it is left to resume: a parked container lab whose stopped containers
        // were pruned (or Docker reset) can only start fresh, and resuming would fail every time.
        if parked(dir).is_some() && runtime == Runtime::Docker && local_vm(dir).is_none() && docker::containers(dir, id).await.is_ok_and(|n| n == 0) {
            log("This lab was shut down here, but its stopped containers are gone: starting it fresh.".into());
            mark_parked(dir, None)?;
        }
        if parked(dir).is_some() {
            log("This lab is parked on this machine: resuming it as it was. Stop it first if you want a fresh copy.".into());
            return resume_locked(app, dir, id, runtime, &mut log).await;
        }
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
                // The lab is up at this point; a failing attack box shouldn't read as a failed
                // deploy. Note it and carry on so the lab stays usable (the shell can retry it).
                if let Err(e) = attack_box_vagrant(&vagrant, &spec, env, &mut log).await {
                    log(format!("The lab is running, but its attack box didn't start: {e}. Open the lab shell to retry it."));
                }
                registry::record(dir, &spec, lab::vagrant_target(runtime), None);
                welcome(dir, &spec, lab::vagrant_target(runtime), &mut log);
                Ok(())
            }
            Runtime::Docker => {
                let spec = lab::prepare(dir, isoloom_core::Target::Docker)?;
                mark_local_vm(dir, None)?;
                docker::start(dir, id, env, &mut log).await?;
                exegol::rejoin(id).await;
                registry::record_docker(dir, &spec, docker::project(id));
                // Its ports here are the ones picked at its first start, not the spec's.
                let published = docker::published(dir, id, env).await;
                if let Some(m) = lab::message_at(dir, &spec, isoloom_core::Target::Docker, &published) {
                    m.lines().for_each(|l| log(l.to_string()));
                }
                Ok(())
            }
            Runtime::Vm => {
                let provider = provider.ok_or_else(|| Error::Invalid("VM labs need a provider".into()))?;
                if provider.is_remote() {
                    return Err(Error::Invalid("pick a server host to run on ESXi or Proxmox".into()));
                }
                let spec = lab::prepare(dir, lab::vagrant_target(runtime))?;
                warn_if_low_memory(&spec, &mut log);
                let vagrant = lab::vagrant_dir(dir, runtime);
                start_local_vm(&vagrant, provider, env, &mut log).await?;
                registry::record(dir, &spec, lab::vagrant_target(runtime), None);
                welcome(dir, &spec, lab::vagrant_target(runtime), &mut log);
                // The lab's networks are internal to the hypervisor, so the learner's attack VM
                // (their own box, chosen in Settings) goes beside it, on the same hypervisor. The
                // lab is up at this point: a failing attacker is noted, not a failed deploy.
                if let Some(b) = attack_vm_box(env)
                    && let Err(e) = attack_vm::start(dir, &vagrant, provider, b, &mut log).await
                {
                    log(format!("The lab is running, but its attack VM didn't start: {e}. Start it from the lab page to retry."));
                }
                Ok(())
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
            registry::record(dir, &spec, target, provider.is_cloud().then_some(tf));
            welcome(dir, &spec, lab::vagrant_target(runtime), &mut log);
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
            if runtime == Runtime::Docker
                && let Err(e) = attack_box_vagrant(&vagrant, &spec, &env, &mut log).await
            {
                log(format!("The lab is running, but its attack box didn't start: {e}. Open the lab shell to retry it."));
            }
            registry::record(dir, &spec, lab::vagrant_target(runtime), None);
            welcome(dir, &spec, lab::vagrant_target(runtime), &mut log);
            Ok(())
        }
    }
}

/// The lab's own words once it is up (`message:` in its spec, addresses filled in): where to
/// start and what to do first, as the last lines of the deploy log.
fn welcome(dir: &Path, spec: &isoloom_core::Spec, target: isoloom_core::Target, log: &mut impl FnMut(String)) {
    if let Some(m) = lab::message(dir, spec, target) {
        for line in m.lines() {
            log(line.to_string());
        }
    }
}

/// Marks a container lab as running in a VM on this machine (Isoloom's docker-vm),
/// so stop, status and the attack-box shell go to the VM instead of local Docker.
pub const LOCAL_VM_MARKER: &str = ".cyberctf-local-vm";

/// Guards a local start: refuses when the lab is already running on this machine (Docker or a
/// local VM), and otherwise tears down any stopped or half-created leftovers from a previous
/// start so the fresh start doesn't trip over them (a poweroff VM, dead containers).
/// Warns (without blocking) when the host likely can't fit all of a one-VM-per-machine lab's
/// memory, so an out-of-memory failure mid-boot isn't a surprise. Not used for a container lab
/// in a single VM, where the total would overcount.
fn warn_if_low_memory(spec: &isoloom_core::Spec, log: &mut impl FnMut(String)) {
    use sysinfo::System;
    let needed_mb = u64::from(isoloom_core::totals(spec).memory_mb);
    let mut sys = System::new();
    sys.refresh_memory();
    let available_mb = sys.available_memory() / (1024 * 1024);
    if available_mb > 0 && needed_mb > available_mb {
        log(format!(
            "This lab's VMs ask for about {needed_mb} MB, but only ~{available_mb} MB is free on this machine. It may run slowly or fail to boot; close other apps or stop other labs if it struggles."
        ));
    }
}

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

/// Whether the lab runs on this machine right now: its containers, or a local VM of it. An
/// upgrade must not swap the folder out from under it (its containers bind-mount files from it).
pub async fn running_here(dir: &Path, id: &str) -> bool {
    if docker::status(dir, id).await.is_ok_and(|s| s.running) {
        return true;
    }
    for rt in [Runtime::Docker, Runtime::Vm] {
        let vdir = lab::vagrant_dir(dir, rt);
        if vdir.join("Vagrantfile").exists() && vm::status(&vdir, &[]).await.is_ok_and(|s| s.running) {
            return true;
        }
    }
    false
}

/// [`running_here`] for a lab by id; false when it isn't installed.
pub async fn lab_running_here(app: &AppHandle, id: &str) -> bool {
    match lab_dir(app, id) {
        Ok(dir) if dir.exists() => running_here(&dir, id).await,
        _ => false,
    }
}

async fn ensure_local_slot_free(dir: &Path, id: &str, log: &mut impl FnMut(String)) -> Result<()> {
    // Docker containers of this lab on this machine (best effort: before the first start the
    // compose file may not exist yet, and status then errors, which just means nothing to clear).
    if let Ok(s) = docker::status(dir, id).await {
        if s.running {
            return Err(Error::Invalid("This lab is already running on this machine. Stop it before starting it again.".into()));
        }
        if docker::containers(dir, id).await.is_ok_and(|n| n > 0) {
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

/// Written when the launcher parks a lab (paused or shut down), so a later start resumes its
/// machines instead of clearing them as leftovers; removed on resume and on stop.
pub const PARKED_MARKER: &str = ".cyberctf-parked";

fn mark_parked(dir: &Path, mode: Option<Park>) -> Result<()> {
    match mode {
        Some(m) => std::fs::write(dir.join(PARKED_MARKER), m.id())?,
        None => {
            let _ = std::fs::remove_file(dir.join(PARKED_MARKER));
        }
    }
    Ok(())
}

fn parked(dir: &Path) -> Option<Park> {
    std::fs::read_to_string(dir.join(PARKED_MARKER)).ok().and_then(|s| Park::from_id(&s))
}

/// Parks a lab running on this machine: its machines are kept and resume as they were, so a lab
/// that took an hour to build comes back in seconds (paused) or a boot (shut down), not a rebuild.
async fn park(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, mode: Park, mut log: impl FnMut(String)) -> Result<()> {
    let lock = lab_lock(id);
    let _guard = lock.lock().await;
    let _deploy = DeployGuard::new(id, Action::Park);
    if server::lab_connection(app, dir)?.is_some() {
        return Err(Error::Invalid("Pausing a lab on a server host isn't available yet. Stop it instead.".into()));
    }
    match runtime {
        Runtime::Docker if local_vm(dir).is_some() => {
            // Inside the VM the containers don't restart on their own after a power-off, so a
            // container lab in a VM is paused (its state saved), never shut down.
            if mode == Park::Shutdown {
                return Err(Error::Invalid("A container lab running in a VM can be paused, not shut down.".into()));
            }
            vm::park(&lab::vagrant_dir(dir, runtime), mode, &[], &mut log).await?;
        }
        Runtime::Docker => docker::park(dir, id, &mut log).await?,
        Runtime::Vm => {
            if let Err(e) = attack_vm::park(dir, mode, &mut log).await {
                log(format!("The attack VM didn't park: {e}"));
            }
            vm::park(&lab::vagrant_dir(dir, runtime), mode, &[], &mut log).await?;
        }
    }
    mark_parked(dir, Some(mode))?;
    log(match mode {
        Park::Pause => "Lab paused. Resume it to pick up where you left off.".into(),
        Park::Shutdown => "Lab shut down. Resume it to boot its machines again.".into(),
    });
    Ok(())
}

/// Brings a parked lab back, as it was.
async fn resume(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, mut log: impl FnMut(String)) -> Result<()> {
    let lock = lab_lock(id);
    let _guard = lock.lock().await;
    let _deploy = DeployGuard::new(id, Action::Start);
    resume_locked(app, dir, id, runtime, &mut log).await
}

/// The body of `resume`, for a caller already holding the lab lock (a start on a parked lab).
/// Also the repair for a lab some machines of which went down (powered off by hand, or a cut
/// resume): the machines already up are left alone, the others come back.
async fn resume_locked(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, log: &mut impl FnMut(String)) -> Result<()> {
    if server::lab_connection(app, dir)?.is_some() {
        return Err(Error::Invalid("This lab was parked on a server host; resuming there isn't available yet.".into()));
    }
    log("Resuming the lab…".into());
    match runtime {
        Runtime::Docker if local_vm(dir).is_some() => vm::resume(&lab::vagrant_dir(dir, runtime), &[], &mut *log).await?,
        Runtime::Docker => {
            // Its stopped containers pruned (or Docker reset): nothing to bring back. Say so and
            // drop the parked mark, so the page offers a fresh start instead of a resume that
            // fails on "no container to start" every time.
            if docker::containers(dir, id).await.is_ok_and(|n| n == 0) {
                mark_parked(dir, None)?;
                return Err(Error::Invalid("Nothing is left of this lab to resume (its stopped containers are gone). Start it again for a fresh copy.".into()));
            }
            docker::resume(dir, id, &mut *log).await?;
            // Recorded again, with its Compose project (labs started before it was recorded).
            if let Ok(spec) = lab::instanced(dir) {
                registry::record_docker(dir, &spec, docker::project(id));
            }
        }
        Runtime::Vm => {
            vm::resume(&lab::vagrant_dir(dir, runtime), &[], &mut *log).await?;
            if let Err(e) = attack_vm::resume(dir, &mut *log).await {
                log(format!("The lab is back, but its attack VM didn't resume: {e}. Start it from the lab page."));
            }
        }
    }
    mark_parked(dir, None)?;
    log("Lab resumed.".into());
    Ok(())
}

/// Runs a VM lab's provisioners again on its running machines (one, or all): the repair for a
/// machine whose provisioning was cut short, without rebuilding the lab. Inputs the lab declared
/// (`isoloom.yml` `inputs`) were given at launch and aren't kept, so a lab that provisions from
/// them gets none here; the labs so far declare none.
async fn provision(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, machine: Option<&str>, mut log: impl FnMut(String)) -> Result<()> {
    if runtime != Runtime::Vm {
        return Err(Error::Invalid("Container labs aren't provisioned in place: use Reset for a clean copy.".into()));
    }
    let lock = lab_lock(id);
    let _guard = lock.lock().await;
    let _deploy = DeployGuard::new(id, Action::Start);
    let conn = server::lab_connection(app, dir)?;
    if conn.as_ref().is_some_and(|c| server::terraform_target(c.provider).is_some()) {
        return Err(Error::Invalid("Re-running provisioning isn't available for labs on Proxmox or a cloud yet.".into()));
    }
    let env: Vec<(String, String)> = conn.map(|c| c.env).unwrap_or_default();
    let vagrant = lab::vagrant_dir(dir, runtime);
    let status = vm::status(&vagrant, &env).await?;
    if !status.running {
        return Err(Error::Invalid("Start (or resume) the lab first: provisioning runs on its running machines.".into()));
    }
    if let Some(m) = machine
        && !status.machines.iter().any(|x| x.name == m)
    {
        return Err(Error::Invalid(format!("this lab has no machine `{m}`")));
    }
    log(match machine {
        Some(m) => format!("Re-running provisioning on {m}…"),
        None => "Re-running provisioning on every machine…".into(),
    });
    vm::provision(&vagrant, machine, &env, &mut log).await?;
    log("Provisioning done.".into());
    Ok(())
}

/// Destroys a parked lab's machines before the lab folder is replaced by a newer version of the
/// lab (they'd otherwise be orphaned at the hypervisor, Vagrant having lost track of them).
pub async fn clear_parked(dir: &Path, id: &str, log: &impl Fn(String)) {
    if parked(dir).is_none() {
        return;
    }
    log("A parked copy of an older version of this lab is here: removing it…".into());
    let mut sink = |l: String| log(l);
    // A container lab here: its containers go by their Compose project, wherever (or whether)
    // its generated Compose file is (Isoloom labs keep it under .isoloom-<n>/, not at the root).
    if local_vm(dir).is_none() {
        let _ = docker::stop(dir, id, &mut sink).await;
    }
    for rt in [Runtime::Docker, Runtime::Vm] {
        let vdir = lab::vagrant_dir(dir, rt);
        if vdir.join("Vagrantfile").exists() {
            let _ = vm::stop(&vdir, &[], &mut sink).await;
        }
    }
    attack_vm::stop(dir, &mut sink).await;
    let _ = mark_parked(dir, None);
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

/// For a VM lab the same key carries the attack VM's Vagrant box (`owner/name`) instead of a
/// container image.
fn attack_vm_box(env: &[(String, String)]) -> Option<&str> {
    env.iter().find(|(k, _)| k == "CYBERCTF_ATTACKBOX_IMAGE").map(|(_, v)| v.as_str()).filter(|b| attack_vm::valid_box(b))
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
    // Several resolvers, tried in turn: this is a hard dependency of every cloud launch (the
    // firewall is locked to this machine's IP), so one endpoint being down or blocked must not
    // fail the launch. Each has its own short timeout so a hanging endpoint doesn't stall it.
    const RESOLVERS: [&str; 4] = ["https://checkip.amazonaws.com", "https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"];
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|e| Error::Invalid(e.to_string()))?;
    let mut last = String::new();
    for url in RESOLVERS {
        match client.get(url).send().await.and_then(|r| r.error_for_status()) {
            Ok(resp) => match resp.text().await {
                Ok(body) if body.trim().parse::<std::net::Ipv4Addr>().is_ok() => return Ok(body.trim().to_string()),
                Ok(_) => last = format!("{url} gave an unexpected answer"),
                Err(e) => last = format!("{url}: {e}"),
            },
            Err(e) => last = format!("{url}: {e}"),
        }
    }
    Err(Error::Invalid(format!(
        "Couldn't determine your public IP, needed to allow only your machine through the lab's firewall. Check your internet connection and try again. ({last})"
    )))
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
async fn stop_locked(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, mut log: impl FnMut(String)) -> Result<()> {
    let _deploy = DeployGuard::new(id, Action::Stop);
    let conn = server::lab_connection(app, dir)?;
    let result = match (runtime, conn) {
        (Runtime::Docker, None) if local_vm(dir).is_some() => vm::stop(&lab::vagrant_dir(dir, runtime), &[], log).await,
        (Runtime::Docker, None) => docker::stop(dir, id, log).await,
        (Runtime::Vm, None) => {
            // The learner's attack VM goes with the lab it was started beside.
            attack_vm::stop(dir, &mut log).await;
            vm::stop(&lab::vagrant_dir(dir, runtime), &[], log).await
        }
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
        registry::forget(dir);
        mark_parked(dir, None)?;
    }
    result
}

async fn status(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime) -> Result<LabStatus> {
    let Some(c) = server::lab_connection(app, dir)? else {
        let s: Result<LabStatus> = match runtime {
            // Shown like a remote lab (the attack box lives in the VM, reached over SSH).
            Runtime::Docker if let Some(p) = local_vm(dir) => {
                let status = vm::status(&lab::vagrant_dir(dir, runtime), &[]).await?;
                Ok(LabStatus { host: Some(format!("{} VM on this machine", vm_label(&p))), place: Some(Place::LocalVm), provider: Some(p.clone()), ..status })
            }
            Runtime::Docker => Ok(LabStatus { place: Some(Place::Container), ..docker::status(dir, id).await? }),
            Runtime::Vm => Ok(LabStatus { place: Some(Place::LocalVm), ..vm::status(&lab::vagrant_dir(dir, runtime), &[]).await? }),
        };
        let s = s?;
        // Parked = the launcher parked it and it is still down; a lab someone started again by
        // hand (or that is up for any reason) is simply running.
        return Ok(LabStatus { parked: parked(dir).filter(|_| !s.running), ..s });
    };
    let status = match server::terraform_target(c.provider) {
        Some(tf) => terraform::status(&state_dir(app, id, tf)?),
        None => vm::status(&lab::vagrant_dir(dir, runtime), &c.env).await?,
    };
    let place = if c.provider.is_cloud() { Place::Cloud } else { Place::Server };
    Ok(LabStatus { host: Some(c.name), place: Some(place), provider: Some(c.provider.id().to_string()), ..status })
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
        Runtime::Docker if !dir.join(server::HOST_MARKER).exists() && local_vm(dir).is_none() => docker::primary_url(dir, id).await,
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
    // A deploy still running in its worker process is stopped first, so the teardown never races
    // a `vagrant up` or `compose up` that would recreate what it removes; same for an attack VM
    // start beside it.
    crate::deploy_worker::kill_and_wait(&app, &id).await;
    crate::deploy_worker::kill_and_wait(&app, &crate::deploy_worker::attack_key(&id)).await;
    stop(&app, &dir, &id, runtime, log).await
}

/// The bodies of the lab operations the deploy worker runs (`deploy_worker::execute`), by lab id.
pub async fn park_lab(app: &AppHandle, id: &str, runtime: Runtime, mode: Park, log: impl FnMut(String)) -> Result<()> {
    park(app, &lab_dir(app, id)?, id, runtime, mode, log).await
}

pub async fn resume_lab(app: &AppHandle, id: &str, runtime: Runtime, log: impl FnMut(String)) -> Result<()> {
    resume(app, &lab_dir(app, id)?, id, runtime, log).await
}

pub async fn provision_lab(app: &AppHandle, id: &str, runtime: Runtime, machine: Option<&str>, log: impl FnMut(String)) -> Result<()> {
    provision(app, &lab_dir(app, id)?, id, runtime, machine, log).await
}

pub async fn start_attack_vm(app: &AppHandle, id: &str, box_name: &str, log: impl FnMut(String)) -> Result<()> {
    let dir = lab_dir(app, id)?;
    let vagrant = lab::vagrant_dir(&dir, Runtime::Vm);
    let status = vm::status(&vagrant, &[]).await?;
    // The lab's internal networks exist as soon as one of its VMs is up; the attacker needn't
    // wait for the last machine to finish booting (and the UI may ask while that happens).
    if !status.machines.iter().any(|m| m.state == "running") {
        return Err(Error::Invalid("start the lab first: the attack VM joins its networks".into()));
    }
    let provider = status
        .provider
        .as_deref()
        .and_then(providers::Provider::from_id)
        .ok_or_else(|| Error::Invalid("couldn't tell which hypervisor the lab runs on".into()))?;
    attack_vm::start(&dir, &vagrant, provider, box_name, log).await
}

/// Pauses (state saved) or shuts down (powered off) a lab on this machine, keeping its machines
/// so it resumes as it was. Runs detached (a worker), like every lab operation.
#[tauri::command]
pub async fn lab_park(app: AppHandle, id: String, runtime: Runtime, mode: Park, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    crate::deploy_worker::run_job(&app, crate::deploy_worker::Job::on_lab(&id, crate::deploy_worker::Op::Park { runtime, mode }), logs).await
}

/// Runs a VM lab's provisioners again, on one machine (`machine`) or all of them.
#[tauri::command]
pub async fn lab_provision(app: AppHandle, id: String, runtime: Runtime, machine: Option<String>, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    if let Some(m) = &machine
        && !(m.len() <= 64 && m.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'))
    {
        return Err(Error::Invalid(format!("invalid machine name `{m}`")));
    }
    crate::deploy_worker::run_job(&app, crate::deploy_worker::Job::on_lab(&id, crate::deploy_worker::Op::Provision { runtime, machine }), logs).await
}

/// Brings a parked lab back (or the machines of a lab that went down).
#[tauri::command]
pub async fn lab_resume(app: AppHandle, id: String, runtime: Runtime, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    crate::deploy_worker::run_job(&app, crate::deploy_worker::Job::on_lab(&id, crate::deploy_worker::Op::Resume { runtime }), logs).await
}

/// Stops a lab with no log sink, for a caller that only needs the teardown (the hosted agent
/// cleaning up after a launch that started infra but then failed to report back).
pub async fn stop_lab(app: &AppHandle, id: &str, runtime: Runtime) -> Result<()> {
    let dir = lab_dir(app, id)?;
    stop(app, &dir, id, runtime, |_l: String| {}).await
}

#[tauri::command]
pub async fn lab_status(app: AppHandle, id: String, runtime: Runtime) -> Result<LabStatus> {
    let dir = lab_dir(&app, &id)?;
    status(&app, &dir, &id, runtime).await
}

/// The observers a lab puts beside itself (`tools:` in its spec), at their addresses where it
/// runs (container addresses for a container lab, wherever its Compose file runs).
#[tauri::command]
pub async fn lab_tools(app: AppHandle, id: String, runtime: Runtime) -> Result<Vec<lab::Observer>> {
    let dir = lab_dir(&app, &id)?;
    let spec = lab::instanced(&dir)?;
    Ok(lab::tools(&spec, runtime == Runtime::Docker))
}

/// The ids of labs running on this machine right now, found by scanning Docker and Vagrant
/// directly. Unlike `lab_status` (one lab at a time, from its dir and Compose file), this is a
/// single infrastructure scan, so the UI recovers which labs are up even after a crash or restart
/// — and a lab whose per-lab status probe is momentarily failing still shows as running.
#[tauri::command]
pub async fn running_labs(app: AppHandle) -> Vec<String> {
    discover::running_lab_ids(&app).await
}

/// Runs a lab's exploitability check: does the intended exploit path still work? Lets a
/// learner who broke their box know to reset it. Local Docker labs only for now.
#[tauri::command]
pub async fn lab_check(app: AppHandle, id: String, runtime: Runtime) -> Result<docker::Check> {
    let dir = lab_dir(&app, &id)?;
    match runtime {
        Runtime::Docker if server::lab_connection(&app, &dir)?.is_none() => docker::check(&dir, &id).await,
        _ => Ok(docker::Check { available: false, ok: false, output: String::new(), results: Vec::new() }),
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
            return exegol::open_terminal_async(target.attack_shell_command(&ssh::known_hosts(&app)?)?).await;
        }
        return tokio::task::spawn_blocking(move || exegol::shell(&id)).await.map_err(|e| Error::Invalid(e.to_string()))?;
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
    exegol::open_terminal_async(target.attack_shell_command(&ssh::known_hosts(&app)?)?).await
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
pub async fn exegol_shell(id: String) -> Result<()> {
    validate_id(&id)?;
    // Off the UI thread: finding a terminal that starts can take seconds.
    tokio::task::spawn_blocking(move || exegol::shell(&id)).await.map_err(|e| Error::Invalid(e.to_string()))?
}

/// The attack VM beside a VM lab on this machine, in the container attack box's status shape.
#[tauri::command]
pub async fn attack_vm_status(app: AppHandle, id: String, box_name: String) -> Result<exegol::ExegolStatus> {
    let dir = lab_dir(&app, &id)?;
    if !attack_vm::valid_box(&box_name) {
        return Err(Error::Invalid(format!("invalid attack VM box `{box_name}` (expected owner/name)")));
    }
    Ok(attack_vm::status(&dir, &box_name).await)
}

/// Starts the attack VM beside a running VM lab, on the lab's hypervisor (the first start
/// downloads the box). Runs detached (a worker), so a quit or a rebuild never cuts it short.
#[tauri::command]
pub async fn attack_vm_start(app: AppHandle, id: String, box_name: String, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    if !attack_vm::valid_box(&box_name) {
        return Err(Error::Invalid(format!("invalid attack VM box `{box_name}` (expected owner/name)")));
    }
    crate::deploy_worker::run_job(&app, crate::deploy_worker::Job::on_lab(&id, crate::deploy_worker::Op::AttackVm { box_name }), logs).await
}

#[tauri::command]
pub async fn attack_vm_stop(app: AppHandle, id: String, logs: Channel<String>) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    let log = move |line: String| {
        let _ = logs.send(line);
    };
    // A start still downloading or booting it is stopped first, so the removal is final.
    crate::deploy_worker::kill_and_wait(&app, &crate::deploy_worker::attack_key(&id)).await;
    attack_vm::stop(&dir, log).await;
    Ok(())
}

/// Opens the player's terminal on an SSH session into the attack VM.
#[tauri::command]
pub async fn attack_vm_shell(app: AppHandle, id: String) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    // Off the UI thread: finding a terminal that starts can take seconds.
    tokio::task::spawn_blocking(move || attack_vm::shell(&dir)).await.map_err(|e| Error::Invalid(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::{PARKED_MARKER, Park, local_vm, mark_local_vm, mark_parked, parked, providers::Provider, validate_id};

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
    fn parked_marker_round_trips_and_ignores_garbage() {
        let dir = std::env::temp_dir().join(format!("cyberctf-parked-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(parked(&dir), None);
        mark_parked(&dir, Some(Park::Pause)).unwrap();
        assert_eq!(parked(&dir), Some(Park::Pause));
        mark_parked(&dir, Some(Park::Shutdown)).unwrap();
        assert_eq!(parked(&dir), Some(Park::Shutdown));
        // A marker nothing wrote (or a corrupt one) never counts as parked: start then cleans up.
        std::fs::write(dir.join(PARKED_MARKER), "halted?").unwrap();
        assert_eq!(parked(&dir), None);
        mark_parked(&dir, None).unwrap();
        assert_eq!(parked(&dir), None);
        assert!(!dir.join(PARKED_MARKER).exists());
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
