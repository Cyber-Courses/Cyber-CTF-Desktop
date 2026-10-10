//! What a lab looks like right now, wherever it runs: its machines and networks, where it runs,
//! whether it is parked, and (for a container lab on a Terraform host) the containers read from
//! that host.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::paths::{lab_dir, local_vm, parked, state_dir, vagrant_dirs};
use super::{AttackerAt, LabStatus, Place, Runtime, docker, lab, remote, server, terraform, vm};
use crate::error::Result;

pub(super) async fn status(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime) -> Result<LabStatus> {
    match server::lab_connection(app, dir)? {
        None => local_status(dir, id, runtime).await,
        Some(c) => server_status(app, dir, id, runtime, c).await,
    }
}

pub(super) async fn local_status(dir: &Path, id: &str, runtime: Runtime) -> Result<LabStatus> {
    let s = match runtime {
        // Shown like a remote lab (the attack box lives in the VM, reached over SSH).
        Runtime::Docker if let Some(p) = local_vm(dir) => {
            let status = vm::status(&lab::vagrant_dir(dir, runtime), &[]).await?;
            LabStatus { host: Some(format!("{} VM on this machine", vm_label(&p))), place: Some(Place::LocalVm), provider: Some(p), ..status }
        }
        Runtime::Docker => LabStatus { place: Some(Place::Container), ..docker::status(dir, id).await? },
        Runtime::Vm => LabStatus { place: Some(Place::LocalVm), ..vm::status(&lab::vagrant_dir(dir, runtime), &[]).await? },
    };
    // Parked = the launcher parked it and it is still down; a lab someone started again by
    // hand (or that is up for any reason) is simply running.
    Ok(LabStatus { parked: parked(dir).filter(|_| !s.running), ..s })
}

async fn server_status(app: &AppHandle, dir: &Path, id: &str, runtime: Runtime, c: server::Connection) -> Result<LabStatus> {
    let tf = server::terraform_target(c.provider);
    let status = match tf {
        Some(tf) => terraform::status(&state_dir(app, id, tf)?),
        None => vm::status(&lab::vagrant_dir(dir, runtime), &c.env).await?,
    };
    // Its VMs can be up after a setup step failed (Vagrant on ESXi): not running, left behind.
    let status = LabStatus { running: status.running && !crate::deploy_worker::last_deploy_failed(app, id), ..status };
    // A Docker lab on a Terraform lab host: its containers and the attack box, read from the
    // host. Never the bare VM in their place: until the host answers, no machines (the page
    // says it's reading them).
    let status = match tf {
        Some(tf) if status.running && runtime == Runtime::Docker => match remote_containers(app, id, dir, &state_dir(app, id, tf)?).await {
            Some(found) => found,
            None => LabStatus { machines: Vec::new(), networks: Vec::new(), ..status },
        },
        _ => status,
    };
    let place = if c.provider.is_cloud() { Place::Cloud } else { Place::Server };
    Ok(LabStatus { host: Some(c.name), place: Some(place), provider: Some(c.provider.id().to_string()), ..status })
}

/// A hypervisor's display name, from its Vagrant provider id.
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

/// How long a remote lab's container list is reused: the lab page polls its status every few
/// seconds, and each read is an SSH round trip (through the Proxmox node, sometimes).
const REMOTE_PROBE_TTL: Duration = Duration::from_secs(10);
static REMOTE_PROBES: Mutex<Option<HashMap<String, (Instant, LabStatus)>>> = Mutex::new(None);

/// The compose project a lab runs under: the `name:` of its generated Compose file.
fn compose_project_name(dir: &Path) -> Option<String> {
    compose_name(&std::fs::read_to_string(lab::compose_file(dir)).ok()?)
}

fn compose_name(compose: &str) -> Option<String> {
    compose.lines().find_map(|l| l.strip_prefix("name:").map(|n| n.trim().trim_matches('"').trim_matches('\'').to_string())).filter(|n| !n.is_empty())
}

/// The containers on a Terraform lab host (and the attack box beside them), in the shape of a
/// local Docker lab's status. None when the host can't be read; the caller keeps the VM view.
async fn remote_containers(app: &AppHandle, id: &str, dir: &Path, state: &Path) -> Option<LabStatus> {
    let cached = REMOTE_PROBES.lock().ok().and_then(|g| g.as_ref()?.get(id).filter(|(at, _)| at.elapsed() < REMOTE_PROBE_TTL).map(|(_, s)| s.clone()));
    if cached.is_some() {
        return cached;
    }
    let project = compose_project_name(dir)?;
    let target = remote::terraform_host(app, state).await.ok()??;
    let out = remote::run_on_terraform_host(&target, state, &docker::host_probe_script(&project)).await.ok()?;
    let probe = docker::HostProbe::parse(&out)?;
    let (found, attacker) = docker::status_from_host(&project, &probe);
    if found.machines.is_empty() {
        return None;
    }
    let status = LabStatus { attacker: attacker.map(|(ip, lab_network)| AttackerAt { ip, lab_network }), ..found };
    if let Ok(mut g) = REMOTE_PROBES.lock() {
        g.get_or_insert_with(HashMap::new).insert(id.to_string(), (Instant::now(), status.clone()));
    }
    Some(status)
}

/// Whether the lab runs on this machine right now: its containers, or a local VM of it. An
/// upgrade must not swap the folder out from under it (its containers bind-mount files from it).
pub async fn running_here(dir: &Path, id: &str) -> bool {
    if docker::status(dir, id).await.is_ok_and(|s| s.running) {
        return true;
    }
    for vdir in vagrant_dirs(dir) {
        if vm::status(&vdir, &[]).await.is_ok_and(|s| s.running) {
            return true;
        }
    }
    false
}

/// [`running_here`] for a lab by id; false when it isn't installed.
pub async fn lab_running_here(app: &AppHandle, id: &str) -> bool {
    match lab_dir(app, id) {
        Ok(dir) => running_here(&dir, id).await,
        Err(_) => false,
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

#[cfg(test)]
mod tests {
    use super::{compose_name, vm_label};

    #[test]
    fn compose_name_is_the_top_level_name_unquoted() {
        assert_eq!(compose_name("name: sqli-1\nservices:\n").as_deref(), Some("sqli-1"));
        assert_eq!(compose_name("services:\n  web: {}\nname: \"lab-2\"\n").as_deref(), Some("lab-2"));
        assert_eq!(compose_name("name: 'lab-3'\n").as_deref(), Some("lab-3"));
        // Indented `name:` keys belong to services, not the project.
        assert_eq!(compose_name("services:\n  web:\n    name: nope\n"), None);
        assert_eq!(compose_name("name: \"\"\n"), None);
    }

    #[test]
    fn vm_label_names_known_hypervisors_and_passes_others_through() {
        assert_eq!(vm_label("virtualbox"), "VirtualBox");
        assert_eq!(vm_label("vmware_desktop"), "VMware");
        assert_eq!(vm_label("hyperv"), "Hyper-V");
        assert_eq!(vm_label("qemu"), "qemu");
    }
}
