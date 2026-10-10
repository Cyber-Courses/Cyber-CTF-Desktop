//! A lab after it started: parking (pause, shut down) and resuming it, re-running provisioning,
//! stopping it wherever it runs, and the reaper that destroys expired cloud labs.

use std::path::Path;

use tauri::{AppHandle, Manager};

use super::inflight::{Action, DeployGuard, lock_lab};
use super::paths::{lab_dir, local_vm, mark_local_vm, mark_parked, parked, recorded_runtime, state_dir, vagrant_dirs, validate_id};
use super::{Park, Runtime, attack_vm, docker, lab, registry, server, terraform, vm};
use crate::error::{Error, Result};

/// Parks a lab running on this machine: its machines are kept and resume as they were, so a lab
/// that took an hour to build comes back in seconds (paused) or a boot (shut down), not a rebuild.
async fn park(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, mode: Park, mut log: impl FnMut(String)) -> Result<()> {
    let _lock = lock_lab(id).await;
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
    let _lock = lock_lab(id).await;
    let _deploy = DeployGuard::new(id, Action::Start);
    resume_locked(app, dir, id, runtime, &mut log).await
}

/// The body of `resume`, for a caller already holding the lab lock (a start on a parked lab).
/// Also the repair for a lab some machines of which went down (powered off by hand, or a cut
/// resume): the machines already up are left alone, the others come back.
pub(super) async fn resume_locked(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, log: &mut impl FnMut(String)) -> Result<()> {
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
    let _lock = lock_lab(id).await;
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

/// Stops a lab wherever it runs, destroying remote VMs so the next start is clean.
pub(super) async fn stop(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, log: impl FnMut(String)) -> Result<()> {
    let _lock = lock_lab(id).await;
    stop_locked(app, dir, id, runtime, log).await
}

/// The body of `stop`, assuming the caller already holds the lab lock. The reaper uses this so
/// it can re-check expiry under the same lock before tearing a lab down (the lock is not
/// reentrant, so it must not call `stop`, which would deadlock).
async fn stop_locked(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, mut log: impl FnMut(String)) -> Result<()> {
    let _deploy = DeployGuard::new(id, Action::Stop);
    let result = match server::lab_connection(app, dir)? {
        None if runtime == Runtime::Docker && local_vm(dir).is_some() => vm::stop(&lab::vagrant_dir(dir, runtime), &[], log).await,
        None if runtime == Runtime::Docker => docker::stop(dir, id, log).await,
        None => {
            // The learner's attack VM goes with the lab it was started beside.
            attack_vm::stop(dir, &mut log).await;
            vm::stop(&lab::vagrant_dir(dir, runtime), &[], log).await
        }
        Some(c) => match server::terraform_target(c.provider) {
            Some(tf) => {
                let module = lab::terraform_to_destroy(dir, runtime, tf)?;
                terraform::destroy(&module, &state_dir(app, id, tf)?, &c.tf_vars, &c.tf_env, log).await
            }
            None => vm::stop(&lab::vagrant_dir(dir, runtime), &c.env, log).await,
        },
    };
    if result.is_ok() {
        server::mark_lab(dir, None)?;
        mark_local_vm(dir, None)?;
        registry::forget(dir);
        mark_parked(dir, None)?;
    }
    result
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
    for vdir in vagrant_dirs(dir) {
        let _ = vm::stop(&vdir, &[], &mut sink).await;
    }
    attack_vm::stop(dir, &mut sink).await;
    let _ = mark_parked(dir, None);
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
        let _lock = lock_lab(&id).await;
        if !terraform::expired(&state) {
            continue;
        }
        // Best effort: tear it down to end billing, with the runtime recorded at start. No UI
        // context here, so logs are dropped; if the destroy fails, the next sweep retries.
        let _ = stop_locked(app, &dir, &id, recorded_runtime(&state), |_line: String| {}).await;
    }
}

// The bodies of the lab operations the deploy worker runs (`deploy_worker::execute`), by lab id.

pub async fn park_lab(app: &AppHandle, id: &str, runtime: Runtime, mode: Park, log: impl FnMut(String)) -> Result<()> {
    park(app, &lab_dir(app, id)?, id, runtime, mode, log).await
}

pub async fn resume_lab(app: &AppHandle, id: &str, runtime: Runtime, log: impl FnMut(String)) -> Result<()> {
    resume(app, &lab_dir(app, id)?, id, runtime, log).await
}

pub async fn provision_lab(app: &AppHandle, id: &str, runtime: Runtime, machine: Option<&str>, log: impl FnMut(String)) -> Result<()> {
    provision(app, &lab_dir(app, id)?, id, runtime, machine, log).await
}

/// Stops a lab with no log sink, for a caller that only needs the teardown (the hosted agent
/// cleaning up after a launch that started infra but then failed to report back).
pub async fn stop_lab(app: &AppHandle, id: &str, runtime: Runtime) -> Result<()> {
    stop(app, &lab_dir(app, id)?, id, runtime, |_l: String| {}).await
}
