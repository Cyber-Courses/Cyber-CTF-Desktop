//! What Cyber CTF is running and storing on this machine, for the Machine page.
//!
//! - Workloads: running lab containers (grouped per lab, with memory) and local lab VMs,
//!   each stoppable. Only things Cyber CTF started: containers named `cyberctf-*`, VMs
//!   whose Vagrant home is under the app's lab or self-test folders.
//! - Storage: the container images and Vagrant boxes installed labs (and the self-tests)
//!   use, with sizes, and a clean-up that removes only those. Images still used by a
//!   container, or boxes used by a VM, are left alone (Docker/Vagrant refuse).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::exec::{run, run_env_timed, run_read};
use crate::machine::selftest;
use crate::runtime::providers::Provider;

fn labs_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("labs"))
}

fn installed_labs(app: &AppHandle) -> Vec<(String, PathBuf)> {
    let Ok(dir) = labs_dir(app) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries.flatten().filter(|e| e.path().is_dir()).map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).collect()
}

// ---------- Workloads ----------

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

/// `123.4MiB` / `1.2GiB` / `512kB` → bytes.
fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: f64 = num.trim().parse().unwrap_or(0.0);
    let mult = match unit.trim() {
        "B" => 1.0,
        "kB" | "KB" => 1e3,
        "KiB" => 1024.0,
        "MB" => 1e6,
        "MiB" => 1024.0 * 1024.0,
        "GB" => 1e9,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1e12,
        "TiB" => 1024f64.powi(4),
        _ => 0.0,
    };
    (n * mult) as u64
}

/// Lab id from a container: its compose project (`cyberctf-<id>`) or, for the attack box
/// (`docker run`, no project), its name `cyberctf-<id>-attacker`.
fn lab_of(name: &str, project: &str) -> Option<String> {
    if let Some(id) = project.strip_prefix("cyberctf-") {
        return Some(id.to_string());
    }
    let rest = name.strip_prefix("cyberctf-")?;
    let id = rest.strip_suffix("-attacker").or_else(|| rest.strip_suffix("-exegol")).unwrap_or(rest);
    Some(id.to_string())
}

async fn docker_workloads() -> Vec<Workload> {
    let Ok(ps) =
        run_read("docker", &["ps", "--filter", "name=^cyberctf-", "--format", "{{.ID}}\t{{.Names}}\t{{.Label \"com.docker.compose.project\"}}"], None).await
    else {
        return Vec::new();
    };
    let mut by_lab: BTreeMap<String, (u32, Vec<String>)> = BTreeMap::new();
    for line in ps.lines() {
        let mut f = line.split('\t');
        let (Some(cid), Some(name)) = (f.next(), f.next()) else { continue };
        let project = f.next().unwrap_or("");
        if let Some(id) = lab_of(name, project) {
            let e = by_lab.entry(id).or_default();
            e.0 += 1;
            e.1.push(cid.to_string());
        }
    }
    if by_lab.is_empty() {
        return Vec::new();
    }
    // Memory per container, in one call.
    let ids: Vec<&str> = by_lab.values().flat_map(|(_, c)| c.iter().map(String::as_str)).collect();
    let mut args = vec!["stats", "--no-stream", "--format", "{{.ID}}\t{{.MemUsage}}"];
    args.extend(ids.iter());
    let stats = run_read("docker", &args, None).await.unwrap_or_default();
    let mem: BTreeMap<String, u64> = stats
        .lines()
        .filter_map(|l| {
            let (id, usage) = l.split_once('\t')?;
            Some((id.to_string(), parse_size(usage.split('/').next().unwrap_or(""))))
        })
        .collect();
    by_lab
        .into_iter()
        .map(|(id, (count, cids))| {
            let mem_bytes =
                cids.iter().map(|c| mem.iter().find(|(k, _)| c.starts_with(k.as_str()) || k.starts_with(c.as_str())).map(|(_, v)| *v).unwrap_or(0)).sum();
            Workload { id, kind: "docker", count, mem_bytes, provider: None }
        })
        .collect()
}

/// Running local VMs from `vagrant global-status`, kept to the app's own folders.
async fn vm_workloads(app: &AppHandle) -> Vec<Workload> {
    // Timed: `vagrant global-status` talks to VirtualBox, which can be wedged. Without a limit a
    // polled call would hang and stack up one blocked process per tick.
    let Ok(out) = run_env_timed("vagrant", &["global-status", "--prune", "--machine-readable"], None, &[], std::time::Duration::from_secs(30)).await else {
        return Vec::new();
    };
    let labs = labs_dir(app).ok();
    let selftest_dir = selftest::work_dir(app, "vm").ok();

    // Records come as consecutive lines: machine-id, provider-name, machine-home, state, ...
    #[derive(Default)]
    struct Rec {
        provider: String,
        home: String,
        state: String,
    }
    let mut recs: Vec<Rec> = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(4, ',').collect();
        if parts.len() < 4 {
            continue;
        }
        match parts[2] {
            "machine-id" => recs.push(Rec::default()),
            "provider-name" => {
                if let Some(r) = recs.last_mut() {
                    r.provider = parts[3].to_string();
                }
            }
            "machine-home" => {
                if let Some(r) = recs.last_mut() {
                    r.home = parts[3].to_string();
                }
            }
            "state" => {
                if let Some(r) = recs.last_mut() {
                    r.state = parts[3].to_string();
                }
            }
            _ => {}
        }
    }

    let mut by_lab: BTreeMap<String, (u32, String)> = BTreeMap::new();
    for r in recs.into_iter().filter(|r| r.state == "running") {
        // Remote hosts (ESXi) also show up here; they're not on this machine.
        if r.provider == "vmware_esxi" || r.provider == "proxmox" {
            continue;
        }
        let home = Path::new(&r.home);
        let id = if selftest_dir.as_deref() == Some(home) {
            "selftest".to_string()
        } else if let Some(id) = labs.as_deref().and_then(|l| home.strip_prefix(l).ok()).and_then(|rel| rel.components().next()) {
            id.as_os_str().to_string_lossy().into_owned()
        } else {
            continue;
        };
        let e = by_lab.entry(id).or_insert((0, r.provider.clone()));
        e.0 += 1;
    }
    by_lab.into_iter().map(|(id, (count, provider))| Workload { id, kind: "vm", count, mem_bytes: 0, provider: Some(provider) }).collect()
}

#[tauri::command]
pub async fn machine_workloads(app: AppHandle) -> Vec<Workload> {
    let (mut d, v) = tokio::join!(docker_workloads(), vm_workloads(&app));
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
        "docker" => {
            let project = format!("cyberctf-{id}");
            let _ = run("docker", &["compose", "-p", &project, "down", "-t", "5", "--remove-orphans"], None).await;
            // Whatever is left with the lab's name prefix (the attack box is a plain `docker run`).
            let left = run("docker", &["ps", "-aq", "--filter", &format!("name=^{project}-")], None).await.unwrap_or_default();
            let ids: Vec<&str> = left.split_whitespace().collect();
            if !ids.is_empty() {
                let mut args = vec!["rm", "-f"];
                args.extend(ids);
                run("docker", &args, None).await?;
            }
            Ok(())
        }
        "vm" => {
            // A lab's VMs: one per machine (.isoloom/vagrant) or Docker on one VM (.isoloom/docker-vm).
            let dirs: Vec<PathBuf> = if id == "selftest" {
                vec![selftest::work_dir(&app, "vm")?]
            } else {
                let lab = labs_dir(&app)?.join(&id);
                vec![lab.join(".isoloom/vagrant"), lab.join(".isoloom/docker-vm")]
            };
            let dirs: Vec<PathBuf> = dirs.into_iter().filter(|d| d.join("Vagrantfile").is_file()).collect();
            if dirs.is_empty() {
                return Err(Error::Invalid(format!("no VMs found for `{id}`")));
            }
            for dir in dirs {
                run("vagrant", &["destroy", "-f"], Some(&dir)).await?;
            }
            Ok(())
        }
        _ => Err(Error::Invalid(format!("unknown workload kind `{kind}`"))),
    }
}

// ---------- Storage ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredItem {
    pub name: String,
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    /// Container images labs, the attack box and the self-test use, present locally.
    pub images: Vec<StoredItem>,
    /// Vagrant boxes VM labs and the self-test use, present locally.
    pub boxes: Vec<StoredItem>,
}

/// Images an installed Docker lab's compose file references.
async fn lab_images(dir: &Path, id: &str) -> Vec<String> {
    let project = format!("cyberctf-{id}");
    run("docker", &["compose", "-p", &project, "-f", crate::runtime::lab::COMPOSE_FILE, "config", "--images"], Some(dir))
        .await
        .map(|o| o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// Boxes a Vagrantfile names (`config.vm.box = "..."`, any variable name).
fn vagrantfile_boxes(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            let i = l.find(".vm.box")?;
            let rest = l[i + ".vm.box".len()..].trim_start();
            let rest = rest.strip_prefix('=')?.trim_start();
            let q = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let rest = &rest[1..];
            Some(rest[..rest.find(q)?].to_string())
        })
        .collect()
}

fn vagrant_home() -> Option<PathBuf> {
    std::env::var_os("VAGRANT_HOME").map(PathBuf::from).or_else(|| dirs_home().map(|h| h.join(".vagrant.d")))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(path).map(|it| it.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0)
}

/// Every image and box Cyber CTF uses, by name (present or not).
async fn wanted(app: &AppHandle, extra_images: &[String]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut images: BTreeSet<String> = extra_images.iter().filter(|i| crate::runtime::valid_image(i)).cloned().collect();
    images.insert(selftest::IMAGE.to_string());
    let mut boxes = BTreeSet::new();
    for (id, dir) in installed_labs(app) {
        // The lab's generated files (written when it last ran on that target).
        if dir.join(crate::runtime::lab::COMPOSE_FILE).is_file() {
            images.extend(lab_images(&dir, &id).await);
        }
        boxes.extend(vagrantfile_boxes(&dir.join(".isoloom/vagrant/Vagrantfile")));
        boxes.extend(vagrantfile_boxes(&dir.join(".isoloom/docker-vm/Vagrantfile")));
    }
    let arm = std::env::consts::ARCH == "aarch64";
    for p in [Provider::Virtualbox, Provider::VmwareDesktop, Provider::Parallels, Provider::Utm, Provider::Libvirt, Provider::Qemu, Provider::Hyperv] {
        boxes.extend(selftest::candidate_boxes(p, arm).iter().map(|b| b.to_string()));
    }
    (images, boxes)
}

async fn present(images: &BTreeSet<String>, boxes: &BTreeSet<String>) -> Storage {
    let mut found_images = Vec::new();
    if !images.is_empty() {
        let mut args = vec!["image", "inspect", "--format", "{{index .RepoTags 0}}\t{{.Size}}"];
        args.extend(images.iter().map(String::as_str));
        // `inspect` fails if any image is missing but still prints the ones it found.
        let out = match run("docker", &args, None).await {
            Ok(o) => o,
            Err(_) => {
                let mut o = String::new();
                for img in images {
                    if let Ok(line) = run("docker", &["image", "inspect", "--format", "{{index .RepoTags 0}}\t{{.Size}}", img], None).await {
                        o.push_str(&line);
                    }
                }
                o
            }
        };
        for line in out.lines() {
            if let Some((name, size)) = line.split_once('\t') {
                found_images.push(StoredItem { name: name.to_string(), bytes: size.trim().parse().unwrap_or(0) });
            }
        }
    }

    let mut found_boxes = Vec::new();
    if let Some(home) = vagrant_home() {
        for b in boxes {
            let dir = home.join("boxes").join(b.replace('/', "-VAGRANTSLASH-"));
            if dir.is_dir() {
                found_boxes.push(StoredItem { name: b.clone(), bytes: dir_size(&dir) });
            }
        }
    }
    Storage { images: found_images, boxes: found_boxes }
}

/// `extra_images`: images the UI knows about that the backend doesn't (the attack-box image setting).
#[tauri::command]
pub async fn machine_storage(app: AppHandle, extra_images: Vec<String>) -> Storage {
    let (images, boxes) = wanted(&app, &extra_images).await;
    present(&images, &boxes).await
}

/// Removes the images and boxes `machine_storage` lists. Ones still in use stay. Returns
/// the bytes freed.
#[tauri::command]
pub async fn machine_storage_clean(app: AppHandle, extra_images: Vec<String>) -> Result<u64> {
    let (images, boxes) = wanted(&app, &extra_images).await;
    let before = present(&images, &boxes).await;
    for img in &before.images {
        let _ = run("docker", &["image", "rm", &img.name], None).await;
    }
    for b in &before.boxes {
        // No --force: Vagrant refuses to remove a box a VM still uses.
        let _ = run("vagrant", &["box", "remove", &b.name, "--all"], None).await;
    }
    let after = present(&images, &boxes).await;
    let total = |s: &Storage| s.images.iter().chain(&s.boxes).map(|i| i.bytes).sum::<u64>();
    Ok(total(&before).saturating_sub(total(&after)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_sizes() {
        assert_eq!(parse_size("512B"), 512);
        assert_eq!(parse_size("1.5GiB"), (1.5 * 1024.0 * 1024.0 * 1024.0) as u64);
        assert_eq!(parse_size(" 20MiB "), 20 * 1024 * 1024);
    }

    #[test]
    fn maps_containers_to_labs() {
        assert_eq!(lab_of("cyberctf-sqli-web-1", "cyberctf-sqli").as_deref(), Some("sqli"));
        assert_eq!(lab_of("cyberctf-sqli-attacker", "").as_deref(), Some("sqli"));
        assert_eq!(lab_of("postgres", ""), None);
    }

    #[test]
    fn reads_boxes_from_vagrantfiles() {
        let dir = std::env::temp_dir().join("cyberctf-vf-test");
        std::fs::create_dir_all(&dir).unwrap();
        let vf = dir.join("Vagrantfile");
        std::fs::write(&vf, "Vagrant.configure('2') do |c|\n  c.vm.box = \"bento/debian-12\"\n  dc.vm.box = 'gusztavvargadr/windows-server'\nend\n").unwrap();
        assert_eq!(vagrantfile_boxes(&vf), vec!["bento/debian-12", "gusztavvargadr/windows-server"]);
    }
}
