//! The Tauri commands over lab runtimes. They validate what the UI passes (ids, images, boxes,
//! machine names), hand long operations to the detached deploy worker, and stream logs back
//! over a channel.

use tauri::AppHandle;
use tauri::ipc::Channel;

use super::launch::start;
use super::lifecycle::stop;
use super::paths::{lab_dir, validate_id};
use super::shell::lab_shell_command;
use super::{LabStatus, Park, Runtime, attack_vm, discover, docker, exegol, lab, providers, server, status};
use crate::deploy_worker::{self, Job, Op};
use crate::error::{Error, Result};

/// A log sink that streams each line to the UI.
fn channel_log(logs: Channel<String>) -> impl Fn(String) + Send + Sync + 'static {
    move |line: String| {
        let _ = logs.send(line);
    }
}

fn check_image(image: &str) -> Result<()> {
    if exegol::valid_image(image) { Ok(()) } else { Err(Error::Invalid(format!("invalid attack-box image `{image}`"))) }
}

fn check_box(box_name: &str) -> Result<()> {
    if attack_vm::valid_box(box_name) { Ok(()) } else { Err(Error::Invalid(format!("invalid attack VM box `{box_name}` (expected owner/name)"))) }
}

/// A machine name as Vagrant and Isoloom spell them: plain characters, dots allowed.
fn valid_machine_name(m: &str) -> bool {
    m.len() <= 64 && m.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
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
    start(&app, &dir, &id, runtime, provider, host.as_deref(), &[], channel_log(logs)).await
}

#[tauri::command]
pub async fn lab_stop(app: AppHandle, id: String, runtime: Runtime, logs: Channel<String>) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    // A deploy still running in its worker process is stopped first, so the teardown never races
    // a `vagrant up` or `compose up` that would recreate what it removes; same for an attack VM
    // start beside it.
    deploy_worker::kill_and_wait(&app, &id).await;
    deploy_worker::kill_and_wait(&app, &deploy_worker::attack_key(&id)).await;
    stop(&app, &dir, &id, runtime, channel_log(logs)).await
}

/// Pauses (state saved) or shuts down (powered off) a lab on this machine, keeping its machines
/// so it resumes as it was. Runs detached (a worker), like every lab operation.
#[tauri::command]
pub async fn lab_park(app: AppHandle, id: String, runtime: Runtime, mode: Park, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    deploy_worker::run_job(&app, Job::on_lab(&id, Op::Park { runtime, mode }), logs).await
}

/// Runs a VM lab's provisioners again, on one machine (`machine`) or all of them.
#[tauri::command]
pub async fn lab_provision(app: AppHandle, id: String, runtime: Runtime, machine: Option<String>, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    if let Some(m) = &machine
        && !valid_machine_name(m)
    {
        return Err(Error::Invalid(format!("invalid machine name `{m}`")));
    }
    deploy_worker::run_job(&app, Job::on_lab(&id, Op::Provision { runtime, machine }), logs).await
}

/// Brings a parked lab back (or the machines of a lab that went down).
#[tauri::command]
pub async fn lab_resume(app: AppHandle, id: String, runtime: Runtime, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    deploy_worker::run_job(&app, Job::on_lab(&id, Op::Resume { runtime }), logs).await
}

#[tauri::command]
pub async fn lab_status(app: AppHandle, id: String, runtime: Runtime) -> Result<LabStatus> {
    let dir = lab_dir(&app, &id)?;
    status::status(&app, &dir, &id, runtime).await
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
/// single infrastructure scan, so the UI recovers which labs are up even after a crash or restart,
/// and a lab whose per-lab status probe is momentarily failing still shows as running.
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

/// Opens the attack box shell of a running lab in the system terminal.
#[tauri::command]
pub async fn lab_attack_shell(app: AppHandle, id: String, runtime: Runtime) -> Result<()> {
    exegol::open_terminal_async(lab_shell_command(&app, &id, runtime, None).await?.0).await
}

/// Status of a lab's attack box (Exegol), for the lab detail view.
#[tauri::command]
pub async fn exegol_status(id: String, image: String) -> Result<exegol::ExegolStatus> {
    validate_id(&id)?;
    check_image(&image)?;
    Ok(exegol::status(&id, &image).await)
}

/// Launches the attack box on the lab's network (pulls the image first if needed).
#[tauri::command]
pub async fn exegol_start(id: String, image: String, logs: Channel<String>) -> Result<()> {
    validate_id(&id)?;
    check_image(&image)?;
    exegol::start(&id, &image, channel_log(logs)).await
}

#[tauri::command]
pub async fn exegol_stop(id: String, logs: Channel<String>) -> Result<()> {
    validate_id(&id)?;
    exegol::stop(&id, channel_log(logs)).await
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
    check_box(&box_name)?;
    attack_vm::status(&dir, &box_name).await
}

/// Starts the attack VM beside a running VM lab, on the lab's hypervisor (the first start
/// downloads the box). Runs detached (a worker), so a quit or a rebuild never cuts it short.
#[tauri::command]
pub async fn attack_vm_start(app: AppHandle, id: String, box_name: String, logs: Channel<String>) -> Result<()> {
    lab_dir(&app, &id)?;
    check_box(&box_name)?;
    deploy_worker::run_job(&app, Job::on_lab(&id, Op::AttackVm { box_name }), logs).await
}

#[tauri::command]
pub async fn attack_vm_stop(app: AppHandle, id: String, logs: Channel<String>) -> Result<()> {
    let dir = lab_dir(&app, &id)?;
    // A start still downloading or booting it is stopped first, so the removal is final.
    deploy_worker::kill_and_wait(&app, &deploy_worker::attack_key(&id)).await;
    attack_vm::stop(&dir, channel_log(logs)).await;
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
    use super::{channel_log, check_box, check_image, exegol_shell, exegol_start, exegol_status, exegol_stop, valid_machine_name};
    use tauri::ipc::{Channel, InvokeResponseBody};

    /// A channel whose messages land in `sink`.
    fn channel(sink: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> Channel<String> {
        Channel::new(move |body| {
            if let InvokeResponseBody::Json(j) = body {
                sink.lock().unwrap().push(j);
            }
            Ok(())
        })
    }

    #[test]
    fn logs_stream_line_by_line_to_the_ui() {
        let sink = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = channel_log(channel(sink.clone()));
        log("Starting…".into());
        log("Done".into());
        assert_eq!(*sink.lock().unwrap(), ["\"Starting…\"", "\"Done\""]);
    }

    #[tokio::test]
    async fn attack_box_commands_refuse_bad_ids_and_images_before_touching_docker() {
        let bad_id = exegol_status("../x".into(), "nwodtuhs/exegol:free".into()).await.err().unwrap().to_string();
        assert_eq!(bad_id, "invalid lab id `../x`");
        let bad_image = exegol_status("web-1".into(), "-x".into()).await.err().unwrap().to_string();
        assert_eq!(bad_image, "invalid attack-box image `-x`");
        let sink = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        assert!(exegol_start("a b".into(), "nwodtuhs/exegol:free".into(), channel(sink.clone())).await.is_err());
        assert!(exegol_start("web-1".into(), "x;y".into(), channel(sink.clone())).await.is_err());
        assert!(exegol_stop("a;rm".into(), channel(sink.clone())).await.is_err());
        assert!(exegol_shell(String::new()).await.is_err());
        assert!(sink.lock().unwrap().is_empty(), "nothing ran");
    }

    #[test]
    fn machine_names_are_plain() {
        for good in ["dc01", "ws-01", "kingslanding.sevenkingdoms", "a_b"] {
            assert!(valid_machine_name(good), "{good:?} should be accepted");
        }
        for bad in ["a b", "a;rm", "../x", "a/b", "é", &"x".repeat(65)] {
            assert!(!valid_machine_name(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn image_and_box_errors_name_what_was_wrong() {
        assert!(check_image("nwodtuhs/exegol:free").is_ok());
        assert_eq!(check_image("-x").unwrap_err().to_string(), "invalid attack-box image `-x`");
        assert!(check_box("kalilinux/rolling").is_ok());
        assert_eq!(check_box("rolling").unwrap_err().to_string(), "invalid attack VM box `rolling` (expected owner/name)");
    }
}
