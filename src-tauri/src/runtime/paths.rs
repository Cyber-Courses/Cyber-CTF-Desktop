//! Where a lab's files live (its folder, its Terraform state) and the small marker files the
//! launcher leaves next to them to remember how and where the lab was started.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::Runtime;
use super::model::Park;
use super::providers::Provider;
use crate::error::{Error, Result};

pub fn validate_id(id: &str) -> Result<()> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(Error::Invalid(format!("invalid lab id `{id}`"))) }
}

fn app_data(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))
}

/// An installed lab's folder.
pub(super) fn lab_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    validate_id(id)?;
    let dir = app_data(app)?.join("labs").join(id);
    if !dir.is_dir() {
        return Err(Error::Invalid(format!("lab `{id}` is not installed")));
    }
    Ok(dir)
}

/// Terraform state for a lab's target, outside the lab folder.
pub(super) fn state_dir(app: &AppHandle, id: &str, target: &str) -> Result<PathBuf> {
    validate_id(id)?;
    Ok(app_data(app)?.join("deployments").join(id).join(target))
}

/// The lab's vagrant folders (Docker on one VM, one VM per machine) that hold a Vagrantfile, i.e.
/// that a local or ESXi VM of it may have been started from.
pub(super) fn vagrant_dirs(dir: &Path) -> impl Iterator<Item = PathBuf> {
    [Runtime::Docker, Runtime::Vm].into_iter().map(|rt| super::lab::vagrant_dir(dir, rt)).filter(|v| v.join("Vagrantfile").exists())
}

/// Next to a lab's Terraform state: which runtime started it (`DOCKER` or `VM`), for the
/// auto-stop reaper.
const RUNTIME_FILE: &str = "runtime";

fn runtime_tag(runtime: Runtime) -> &'static str {
    if runtime == Runtime::Vm { "VM" } else { "DOCKER" }
}

fn runtime_from_tag(tag: &str) -> Runtime {
    if tag.trim() == "VM" { Runtime::Vm } else { Runtime::Docker }
}

pub(super) fn record_runtime(state: &Path, runtime: Runtime) -> Result<()> {
    std::fs::write(state.join(RUNTIME_FILE), runtime_tag(runtime))?;
    Ok(())
}

/// The runtime recorded at start; containers when nothing (readable) was.
pub(super) fn recorded_runtime(state: &Path) -> Runtime {
    std::fs::read_to_string(state.join(RUNTIME_FILE)).map(|t| runtime_from_tag(&t)).unwrap_or(Runtime::Docker)
}

/// Writes `value` to `dir/name`, or removes the file for `None`.
fn set_marker(dir: &Path, name: &str, value: Option<&str>) -> Result<()> {
    match value {
        Some(v) => std::fs::write(dir.join(name), v)?,
        None => {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
    Ok(())
}

/// Marks a container lab as running in a VM on this machine (Isoloom's docker-vm),
/// so stop, status and the attack-box shell go to the VM instead of local Docker.
pub const LOCAL_VM_MARKER: &str = ".cyberctf-local-vm";

pub(super) fn mark_local_vm(dir: &Path, provider: Option<Provider>) -> Result<()> {
    set_marker(dir, LOCAL_VM_MARKER, provider.map(|p| p.id()))
}

/// The hypervisor a container lab runs on in a local VM, if it does.
pub(super) fn local_vm(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(LOCAL_VM_MARKER)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Written when the launcher parks a lab (paused or shut down), so a later start resumes its
/// machines instead of clearing them as leftovers; removed on resume and on stop.
const PARKED_MARKER: &str = ".cyberctf-parked";

pub(super) fn mark_parked(dir: &Path, mode: Option<Park>) -> Result<()> {
    set_marker(dir, PARKED_MARKER, mode.map(|m| m.id()))
}

pub(super) fn parked(dir: &Path) -> Option<Park> {
    std::fs::read_to_string(dir.join(PARKED_MARKER)).ok().and_then(|s| Park::from_id(&s))
}

#[cfg(test)]
mod tests {
    use super::{PARKED_MARKER, Park, Provider, Runtime, local_vm, mark_local_vm, mark_parked, parked, record_runtime, recorded_runtime, validate_id};

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn local_vm_marker_round_trips() {
        let dir = temp_dir("cyberctf-localvm");
        assert_eq!(local_vm(&dir), None);
        mark_local_vm(&dir, Some(Provider::Virtualbox)).unwrap();
        assert_eq!(local_vm(&dir).as_deref(), Some("virtualbox"));
        mark_local_vm(&dir, None).unwrap();
        assert_eq!(local_vm(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parked_marker_round_trips_and_ignores_garbage() {
        let dir = temp_dir("cyberctf-parked");
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
    fn recorded_runtime_round_trips_and_defaults_to_containers() {
        let dir = temp_dir("cyberctf-runtime");
        // Nothing recorded (a state from before the file existed): containers on one VM.
        assert_eq!(recorded_runtime(&dir), Runtime::Docker);
        record_runtime(&dir, Runtime::Vm).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("runtime")).unwrap(), "VM");
        assert_eq!(recorded_runtime(&dir), Runtime::Vm);
        record_runtime(&dir, Runtime::Docker).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("runtime")).unwrap(), "DOCKER");
        assert_eq!(recorded_runtime(&dir), Runtime::Docker);
        std::fs::write(dir.join("runtime"), "VM\n").unwrap();
        assert_eq!(recorded_runtime(&dir), Runtime::Vm);
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
