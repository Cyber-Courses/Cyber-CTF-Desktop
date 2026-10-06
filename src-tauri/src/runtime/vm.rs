use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::providers::Provider;
use super::{LabStatus, Machine};
use crate::error::Result;
use crate::exec::{run, run_env_timed, stream};

/// A status read must never hang the status poll: a wedged VirtualBox (its global lock held by
/// a stuck VBoxManage) would otherwise pile up one blocked `vagrant status` per poll tick.
const STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// How long a best-effort cleanup `vagrant destroy` may run before we give up waiting and fall
/// back to hypervisor-level teardown: a wedged VirtualBox (a stuck VBoxManage) must not hang a
/// start indefinitely.
const CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// A cleanup `vagrant destroy`, bounded so it can't hang the caller. Errors and timeouts are
/// ignored: the hypervisor-level cleanup that follows handles whatever the destroy didn't.
async fn stop_bounded(dir: &Path, env: &[(String, String)]) {
    let _ = tokio::time::timeout(CLEANUP_TIMEOUT, stop(dir, env, |_l: String| {})).await;
}

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
    // Only hypervisor/Vagrant *startup* errors that a cleanup+retry can actually fix. Deliberately
    // NOT the bare "already exists" / "already registered" / "name is already in use", which also
    // appear in ordinary successful provisioner output ("group docker already exists", a user or
    // network that already exists): matching those would destroy and re-provision a healthy VM.
    let l = line.to_ascii_lowercase();
    l.contains("verr_already_exists") // VirtualBox: the target VM folder already exists
        || l.contains("could not rename") // the import can't rename its folder to the taken name
        || l.contains("is locked") // Vagrant: "the machine is locked" (a dead process's lock)
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
    stop_bounded(dir, env).await;
    let _ = std::fs::remove_dir_all(dir.join(".vagrant"));
}

/// The on-disk folder VirtualBox creates for a VM is a sanitized form of its name: the middot in
/// "lab · dc01" becomes "lab - dc01". This returns the exact folder name candidates for a VM
/// name, so an orphaned folder is matched EXACTLY (never by lossy normalization, which could
/// collide with an unrelated VM like "lab-dc01").
fn folder_candidates(name: &str) -> [String; 2] {
    [name.to_string(), name.replace('\u{00b7}', "-")]
}

/// The VM names Isoloom wrote into the Vagrantfile, used to scope orphan cleanup strictly to
/// this lab's own VMs. Every provider block names the VM on a `v.name` / `v.guest_name` /
/// `v.vmx["displayName"]` line, as the quoted string after the `=` (for `displayName` the key
/// itself is quoted, so taking the value after `=` is what's correct, not the first quote).
fn vm_names(dir: &Path) -> Vec<String> {
    vm_names_from(&std::fs::read_to_string(dir.join("Vagrantfile")).unwrap_or_default())
}

fn vm_names_from(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for raw in text.lines() {
        let l = raw.trim();
        let is_name_line = l.starts_with("v.name") || l.starts_with("v.guest_name") || l.contains("displayName\"]");
        let Some(eq) = l.find('=') else { continue };
        if !is_name_line {
            continue;
        }
        let after = &l[eq + 1..];
        if let Some(open) = after.find('"')
            && let Some(len) = after[open + 1..].find('"')
        {
            let name = &after[open + 1..open + 1 + len];
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

/// Removes VirtualBox VMs and leftover machine folders that belong to this lab (name matches one
/// of `wanted` EXACTLY) but that `vagrant destroy` can't reach: a VM a failed import half-created
/// and never registered with Vagrant, or an orphaned folder that makes the next import fail with
/// VERR_ALREADY_EXISTS. Exact-match only — a lossy match could delete an unrelated VM (e.g. a
/// user's own "lab-dc01" vs this lab's "lab · dc01"), which `unregistervm --delete` can't undo.
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
            if wanted.contains(&name) {
                log(format!("Removing a leftover VM left by a previous run: {name}"));
                let _ = run("VBoxManage", &["controlvm", &uuid, "poweroff"], None).await;
                let _ = run("VBoxManage", &["unregistervm", &uuid, "--delete"], None).await;
            }
        }
    }
    // Unregistered leftover folders (the import failed before registering the VM): delete only a
    // folder whose name is EXACTLY one of our VMs' sanitized folder names.
    let folders: HashSet<String> = wanted.iter().flat_map(|n| folder_candidates(n)).collect();
    if let Some(base) = vbox_machine_folder().await
        && let Ok(entries) = std::fs::read_dir(&base)
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && folders.contains(entry.file_name().to_string_lossy().as_ref()) {
                log(format!("Removing a leftover VM folder: {}", entry.file_name().to_string_lossy()));
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
}

/// Parallels equivalent of `recover_virtualbox` (best effort, exact name match): `prlctl list`
/// then delete ours.
async fn recover_parallels(wanted: &HashSet<String>, log: &mut impl FnMut(String)) {
    let Ok(out) = run("prlctl", &["list", "-a", "--no-header", "-o", "name"], None).await else { return };
    for line in out.lines() {
        let name = line.trim();
        if !name.is_empty() && wanted.contains(name) {
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
    stop_bounded(dir, &[]).await;
    let names: HashSet<String> = vm_names(dir).into_iter().collect();
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
    let mut machines = parse_status(&out);
    let running = !machines.is_empty() && machines.iter().all(|m| m.state == "running");
    // The network diagram, as a Docker lab gets it: addresses are static (declared in the lab),
    // so it comes from the lab's spec (`.isoloom/vagrant` sits two levels under the lab).
    let networks = match dir.parent().and_then(Path::parent).and_then(|lab| super::lab::spec(lab).ok()) {
        Some(spec) => {
            let (mut ifaces, networks) = super::lab::topology(&spec);
            for m in &mut machines {
                if let Some(list) = ifaces.remove(&m.name) {
                    m.ip = list.first().map(|i| i.ip.clone()).unwrap_or_default();
                    m.interfaces = list;
                }
            }
            networks
        }
        None => Vec::new(),
    };
    Ok(LabStatus { running, machines, networks, url: None, host: None, expires_at: None, place: None })
}

#[cfg(test)]
mod tests {
    use super::{folder_candidates, is_stale_state_error, parse_status, vm_names_from};

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

    #[test]
    fn vm_names_reads_the_value_for_every_provider_block() {
        // VirtualBox/Parallels/UTM use `v.name`, ESXi uses `v.guest_name`, VMware uses the quoted
        // key `v.vmx["displayName"]` — the parser must take the VALUE after `=`, not the key.
        let vf = r#"
  config.vm.define "dc01" do |m|
    m.vm.provider "virtualbox" do |v|
      v.name = "minilab · dc01"
    end
    m.vm.provider "vmware_desktop" do |v|
      v.vmx["displayName"] = "minilab · dc01"
    end
    m.vm.provider "vmware_esxi" do |v|
      v.guest_name = "minilab-dc01"
    end
  end
"#;
        let names = vm_names_from(vf);
        assert!(names.contains(&"minilab · dc01".to_string()), "got {names:?}");
        assert!(names.contains(&"minilab-dc01".to_string()), "got {names:?}");
        // The literal key must never be captured as a name.
        assert!(!names.iter().any(|n| n == "displayName"), "captured the key: {names:?}");
    }

    #[test]
    fn folder_candidates_cover_virtualbox_sanitization_exactly() {
        // VirtualBox turns the middot into a hyphen for the on-disk folder; both are exact.
        let c = folder_candidates("minilab · dc01");
        assert!(c.contains(&"minilab · dc01".to_string()));
        assert!(c.contains(&"minilab - dc01".to_string()));
        // It must NOT produce a collapsed form that could match an unrelated "minilab-dc01".
        assert!(!c.iter().any(|f| f == "minilab-dc01"));
    }

    #[test]
    fn stale_state_matches_only_real_startup_errors() {
        assert!(is_stale_state_error("VBoxManage: error: Details: code VERR_ALREADY_EXISTS"));
        assert!(is_stale_state_error("Could not rename the directory"));
        assert!(is_stale_state_error("the machine is locked! This means"));
        assert!(is_stale_state_error("An active machine was found with a different provider"));
        // Benign provisioner output must NOT trigger a destroy+retry of a healthy VM.
        assert!(!is_stale_state_error("group 'docker' already exists"));
        assert!(!is_stale_state_error("user 'vagrant' already exists, skipping"));
        assert!(!is_stale_state_error("network lab already registered"));
    }

    #[test]
    fn keeps_every_state_label_verbatim() {
        // Vagrant reports many lifecycle states; each is surfaced as-is for the UI.
        let out = "ts,a,state,saved\n\
                   ts,b,state,aborted\n\
                   ts,c,state,not_created\n\
                   ts,d,state,running\n";
        let m = parse_status(out);
        let states: Vec<(&str, &str)> = m.iter().map(|m| (m.name.as_str(), m.state.as_str())).collect();
        assert_eq!(states, vec![("a", "saved"), ("b", "aborted"), ("c", "not_created"), ("d", "running")]);
    }

    #[test]
    fn running_requires_every_machine_up() {
        // The `status()` running rule: all machines must be "running".
        let up = parse_status("ts,a,state,running\nts,b,state,running\n");
        assert!(!up.is_empty() && up.iter().all(|m| m.state == "running"));
        let mixed = parse_status("ts,a,state,running\nts,b,state,poweroff\n");
        assert!(!mixed.iter().all(|m| m.state == "running"));
    }

    #[test]
    fn ignores_non_state_lines_and_empty_or_malformed_output() {
        // Only `state` rows with a non-empty target become machines.
        let out = "ts,,ui,info,Current machine states:\n\
                   ts,box,metadata,provider,virtualbox\n\
                   ts,,state,running\n\
                   short,line\n";
        assert!(parse_status(out).is_empty());
        assert!(parse_status("").is_empty());
    }
}
