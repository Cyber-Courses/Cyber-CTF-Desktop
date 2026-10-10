//! What Cyber CTF is running on this machine, for the Machine page: running lab containers
//! (grouped per lab, with memory) and local lab VMs, each stoppable. Only things Cyber CTF
//! started: containers named `cyberctf-*`, VMs whose Vagrant home is under the app's lab or
//! self-test folders.

mod docker;
mod vm;

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{Error, Result};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workload {
    /// Lab id, or `selftest` for a setup test.
    pub id: String,
    /// `docker` or `vm`.
    pub kind: &'static str,
    /// Containers running for it (VMs: 1 per machine).
    pub count: u32,
    /// Memory used, when the runtime reports it (Docker); 0 if unknown.
    pub mem_bytes: u64,
    /// Hypervisor, for VMs.
    pub provider: Option<String>,
}

#[tauri::command]
pub async fn machine_workloads(app: AppHandle) -> Vec<Workload> {
    let (mut d, v) = tokio::join!(docker::workloads(), vm::workloads(&app));
    d.extend(v);
    d
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Stops a workload from the Machine page: removes a lab's containers (incl. its attack
/// box) or destroys its local VMs. The lab can be started again from its page.
#[tauri::command]
pub async fn machine_workload_stop(app: AppHandle, kind: String, id: String) -> Result<()> {
    if !valid_id(&id) {
        return Err(Error::Invalid(format!("invalid id `{id}`")));
    }
    match kind.as_str() {
        "docker" => docker::stop(&id).await,
        "vm" => vm::stop(&app, &id).await,
        _ => Err(Error::Invalid(format!("unknown workload kind `{kind}`"))),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn workload_ids_are_plain_names() {
        assert!(super::valid_id("goad-light_2") && super::valid_id("selftest"));
        assert!(!super::valid_id("") && !super::valid_id("../x") && !super::valid_id(&"a".repeat(65)));
    }
}
