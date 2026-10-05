use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::providers::Provider;
use super::{LabStatus, Machine};
use crate::error::Result;
use crate::exec::{run, run_env_timed, stream};

/// A status read must never hang the status poll: a wedged VirtualBox (its global lock held by
/// a stuck VBoxManage) would otherwise pile up one blocked `vagrant status` per poll tick.
const STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// `env` reaches the Vagrantfile and its provisioners (e.g. the evidence claim).
pub async fn start(dir: &Path, provider: Provider, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    stream("vagrant", &["up", "--provider", provider.id()], Some(dir), env, log).await
}

/// Destroys the VMs so the next start restores the lab's initial state. `env` must carry
/// the same server connection as `start`: Vagrant re-evaluates the Vagrantfile.
pub async fn stop(dir: &Path, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    stream("vagrant", &["destroy", "--force"], Some(dir), env, log).await
}

/// A `vagrant up` line that means the start tripped over leftover state from a crashed or
/// interrupted previous run (an orphaned hypervisor VM or its folder, a stale Vagrant lock)
/// rather than a genuine provisioning failure. Such a start can't succeed until the leftovers
/// are cleared, so the caller clears them (`recover_local`) and tries once more.
pub fn is_stale_state_error(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    l.contains("verr_already_exists")
        || l.contains("could not rename")
        || l.contains("is locked") // Vagrant: "the machine is locked" (a dead process's lock)
        || l.contains("already exists") // VBoxManage / vmware: a VM or folder of that name is left over
        || l.contains("already registered")
        || l.contains("name is already in use")
        || l.contains("different provider") // "an active machine was found with a different provider"
        || l.contains("single provider at a time")
}

/// Reconciles the lab dir against the provider it is about to start on. Vagrant records a
/// machine's provider under `.vagrant/machines/<name>/<provider>/`; starting on a different one
/// (e.g. the lab last ran locally on VirtualBox and is now sent to an ESXi host) makes
/// `vagrant up` refuse with "an active machine was found with a different provider". When the
/// recorded provider differs, tear the old one's machines down (best effort, using whatever env
/// it needs) and reset `.vagrant` so the new provider starts from a clean slate.
pub async fn reconcile_provider(dir: &Path, requested: Provider, env: &[(String, String)], log: &mut impl FnMut(String)) {
    let machines = dir.join(".vagrant").join("machines");
    let Ok(entries) = std::fs::read_dir(&machines) else { return };
    let mut mismatch = false;
    for machine in entries.flatten() {
        if let Ok(provs) = std::fs::read_dir(machine.path()) {
            for prov in provs.flatten() {
                if prov.path().is_dir() && prov.file_name().to_string_lossy() != requested.id() {
                    mismatch = true;
                }
            }
        }
    }
    if !mismatch {
        return;
    }
    log("This lab last ran on a different target. Clearing that state so it can start fresh here…".into());
    let _ = stop(dir, env, |_l: String| {}).await;
    let _ = std::fs::remove_dir_all(dir.join(".vagrant"));
}

/// Normalizes a VM name or folder name for matching: lowercase, every run of non-alphanumerics
/// collapsed to a single space. VirtualBox stores the VM under a sanitized folder name (the
/// middot in "lab · dc01" becomes "lab - dc01"), so the registered name and the on-disk folder
/// only match once separators are normalized away.
fn norm(s: &str) -> String {
    let spaced: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { ' ' }).collect();
    spaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The VM names Isoloom wrote into the Vagrantfile, used to scope orphan cleanup strictly to
/// this lab's own VMs. Every provider block names the VM as the first quoted string on a
/// `v.name` / `v.guest_name` / `v.vmx["displayName"]` line.
fn vm_names(dir: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(dir.join("Vagrantfile")).unwrap_or_default();
    let mut names = Vec::new();
    for raw in text.lines() {
        let l = raw.trim();
        let is_name_line = l.starts_with("v.name") || l.starts_with("v.guest_name") || l.contains("displayName\"]");
        if !is_name_line || !l.contains('=') {
            continue;
        }
        if let Some(open) = l.find('"')
            && let Some(len) = l[open + 1..].find('"')
        {
            let name = &l[open + 1..open + 1 + len];
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

/// VirtualBox's default machine folder (where VM directories live), parsed from
/// `VBoxManage list systemproperties`; falls back to `~/VirtualBox VMs`.
async fn vbox_machine_folder() -> Option<PathBuf> {
    if let Ok(out) = run("VBoxManage", &["list", "systemproperties"], None).await {
        for line in out.lines() {
            if let Some(path) = line.strip_prefix("Default machine folder:") {
                let path = path.trim();
                if !path.is_empty() {
                    return Some(PathBuf::from(path));
                }
            }
        }
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("VirtualBox VMs"))
}

/// Removes VirtualBox VMs and leftover machine folders that belong to this lab (name matches
/// one of `wanted`) but that `vagrant destroy` can't reach: a VM a failed import half-created
/// and never registered with Vagrant, or an orphaned folder that makes the next import fail
/// with VERR_ALREADY_EXISTS. Strictly scoped by name, so unrelated VMs are never touched.
async fn recover_virtualbox(wanted: &HashSet<String>, log: &mut impl FnMut(String)) {
    // Registered VMs of ours that are still around: power off and delete (removes their files).
    if let Ok(out) = run("VBoxManage", &["list", "vms"], None).await {
        for line in out.lines() {
            // `"<name>" {<uuid>}`
            let (Some(open), Some(close)) = (line.rfind('{'), line.rfind('}')) else { continue };
            if close <= open {
                continue;
            }
            let uuid = line[open + 1..close].to_string();
            let name = line[..open].trim().trim_matches('"').to_string();
            if wanted.contains(&norm(&name)) {
                log(format!("Removing a leftover VM left by a previous run: {name}"));
                let _ = run("VBoxManage", &["controlvm", &uuid, "poweroff"], None).await;
                let _ = run("VBoxManage", &["unregistervm", &uuid, "--delete"], None).await;
            }
        }
    }
    // Unregistered leftover folders (the import failed before registering the VM): delete the
    // directory so the next import can create it.
    if let Some(base) = vbox_machine_folder().await
        && let Ok(entries) = std::fs::read_dir(&base)
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && wanted.contains(&norm(&entry.file_name().to_string_lossy())) {
                log(format!("Removing a leftover VM folder: {}", entry.file_name().to_string_lossy()));
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
}

/// Parallels equivalent of `recover_virtualbox` (best effort): `prlctl list` then delete ours.
async fn recover_parallels(wanted: &HashSet<String>, log: &mut impl FnMut(String)) {
    let Ok(out) = run("prlctl", &["list", "-a", "--no-header", "-o", "name"], None).await else { return };
    for line in out.lines() {
        let name = line.trim();
        if !name.is_empty() && wanted.contains(&norm(name)) {
            log(format!("Removing a leftover VM left by a previous run: {name}"));
            let _ = run("prlctl", &["stop", name, "--kill"], None).await;
            let _ = run("prlctl", &["delete", name], None).await;
        }
    }
}

/// Clears leftover local-VM state from a crashed or interrupted run that `vagrant destroy`
/// alone can't fix: a normal destroy first (tracked VMs and most locks), then hypervisor-level
/// removal of this lab's orphaned VMs and folders, then a reset of `.vagrant` so a stale lock a
/// killed process left behind can't block the next `vagrant up`. Best effort throughout: every
/// step tolerates "nothing there". Scoped to this lab's own VM names, so it never touches
/// unrelated VMs on the machine.
pub async fn recover_local(dir: &Path, provider: Provider, log: &mut impl FnMut(String)) {
    let _ = stop(dir, &[], |_l: String| {}).await;
    let names: HashSet<String> = vm_names(dir).iter().map(|n| norm(n)).collect();
    if !names.is_empty() {
        match provider {
            Provider::Virtualbox => recover_virtualbox(&names, log).await,
            Provider::Parallels => recover_parallels(&names, log).await,
            // VMware/UTM/QEMU/libvirt: the destroy above plus the .vagrant reset below are the
            // best we can do portably; their orphan cleanup can be added if it shows up in use.
            _ => {}
        }
    }
    let _ = std::fs::remove_dir_all(dir.join(".vagrant"));
}

// `vagrant status --machine-readable` lines: timestamp,target,type,data...
fn parse_status(out: &str) -> Vec<Machine> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, ',');
            let (_ts, target, kind, data) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
            (kind == "state" && !target.is_empty()).then(|| Machine {
                name: target.to_string(),
                state: data.to_string(),
                image: String::new(),
                ip: String::new(),
                ports: Vec::new(),
                interfaces: Vec::new(),
                services: Vec::new(),
            })
        })
        .collect()
}

pub async fn status(dir: &Path, env: &[(String, String)]) -> Result<LabStatus> {
    let out = run_env_timed("vagrant", &["status", "--machine-readable"], Some(dir), env, STATUS_TIMEOUT).await?;
    let machines = parse_status(&out);
    let running = !machines.is_empty() && machines.iter().all(|m| m.state == "running");
    Ok(LabStatus { running, machines, networks: Vec::new(), url: None, host: None, expires_at: None, place: None })
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    #[test]
    fn parses_machine_readable_status() {
        let out = "1700000000,pfsense-1,metadata,provider,virtualbox\n\
                   1700000000,pfsense-1,state,running\n\
                   1700000000,debian-1,state,poweroff\n\
                   1700000000,,ui,info,Current machine states:\n";
        let machines = parse_status(out);
        assert_eq!(machines.len(), 2);
        assert_eq!(machines[0].name, "pfsense-1");
        assert_eq!(machines[1].state, "poweroff");
    }
}
