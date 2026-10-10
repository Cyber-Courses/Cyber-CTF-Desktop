//! The Server screen's Tauri commands: list, save, remove and test hosts, and what each row
//! shows (running labs, capacity).

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::HOST_MARKER;
use super::checks::{Check, TestResult};
use super::gcp;
use super::input::{HostInput, valid_id};
use super::profile::{HostProfile, new_id};
use super::reachability::test_host;
use super::secrets::{delete_secret, get_secret, host_secret, set_secret};
use super::store::{find, load, load_host, save};
use crate::error::{Error, Result};
use crate::runtime::providers::Provider;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostList {
    default: Option<String>,
    hosts: Vec<HostProfile>,
}

#[tauri::command]
pub fn server_list(app: AppHandle) -> Result<HostList> {
    let store = load(&app)?;
    Ok(HostList { default: store.default, hosts: store.hosts })
}

/// Creates or updates a host. The first host saved becomes the default.
#[tauri::command]
pub fn server_save(app: AppHandle, mut input: HostInput) -> Result<HostProfile> {
    let checked = input.check()?;
    let mut store = load(&app)?;
    let id = match input.id.take() {
        Some(id) if valid_id(&id) && store.hosts.iter().any(|h| h.id == id) => id,
        Some(_) => return Err(Error::Invalid("unknown server host".into())),
        None => new_id(),
    };
    // GCP keeps its labs project across edits, unless the billing account changed.
    let gcp_project = store
        .hosts
        .iter()
        .find(|h| h.id == id && h.provider == Provider::Gcp && input.provider == Provider::Gcp && h.username == checked.username)
        .and_then(|h| h.gcp_project.clone());
    let password = input.password.take();
    let profile = input.into_profile(id.clone(), checked, gcp_project)?;
    match password.filter(|p| !p.is_empty()) {
        Some(p) if p.len() <= 1024 && !p.contains('\0') => set_secret(&id, &p)?,
        Some(_) => return Err(Error::Invalid("invalid password".into())),
        None if profile.keeps_secret() && get_secret(&id).is_err() => {
            return Err(Error::Invalid("enter the host's password".into()));
        }
        None => {}
    }
    match store.hosts.iter_mut().find(|h| h.id == id) {
        Some(existing) => *existing = profile.clone(),
        None => store.hosts.push(profile.clone()),
    }
    if store.default.is_none() && !profile.provider.is_cloud() {
        store.default = Some(id);
    }
    save(&app, &store)?;
    Ok(profile)
}

/// The host id of each installed lab's marker (trimmed; empty when the marker is). A lab leaves
/// a `.cyberctf-host` marker in its directory while it runs on a host (written on start,
/// cleared on stop), so this is filesystem-only: no host calls, no credentials.
fn lab_markers(app: &AppHandle) -> Vec<String> {
    let Ok(labs) = app.path().app_data_dir().map(|d| d.join("labs")) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(labs) else { return Vec::new() };
    entries.flatten().filter_map(|e| std::fs::read_to_string(e.path().join(HOST_MARKER)).ok()).map(|id| id.trim().to_string()).collect()
}

/// Lab counts per host id (markers with no id aren't counted).
fn count_by_host(markers: &[String]) -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for id in markers.iter().filter(|id| !id.is_empty()) {
        *counts.entry(id.clone()).or_default() += 1;
    }
    counts
}

#[tauri::command]
pub fn server_remove(app: AppHandle, id: String) -> Result<()> {
    // Don't strand running labs: this host holds the credentials and state needed to stop and
    // destroy its labs. Removing it mid-run would leave them unstoppable from the app, and a
    // cloud lab would keep billing with no way left to tear it down.
    let running = lab_markers(&app).iter().filter(|m| **m == id).count();
    if running > 0 {
        return Err(Error::Invalid(format!(
            "{running} lab{} still running on this host. Stop {} before removing the host.",
            if running == 1 { "" } else { "s" },
            if running == 1 { "it" } else { "them" },
        )));
    }
    let mut store = load(&app)?;
    store.hosts.retain(|h| h.id != id);
    if store.default.as_deref() == Some(id.as_str()) {
        // The default is a *server* to run VM labs on; a cloud account must never become it.
        store.default = store.hosts.iter().find(|h| !h.provider.is_cloud()).map(|h| h.id.clone());
    }
    save(&app, &store)?;
    delete_secret(&id);
    Ok(())
}

/// Sets (or clears, with None) the host VM labs run on by default.
#[tauri::command]
pub fn server_set_default(app: AppHandle, id: Option<String>) -> Result<()> {
    let mut store = load(&app)?;
    if let Some(id) = &id
        && find(&store, id)?.provider.is_cloud()
    {
        return Err(Error::Invalid("a cloud account can't be the default host".into()));
    }
    store.default = id;
    save(&app, &store)
}

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Notes the app's start, for `launched_recently`.
pub fn mark_started() {
    STARTED.get_or_init(Instant::now);
}

/// Whether the app started less than a minute ago.
fn launched_recently() -> bool {
    STARTED.get_or_init(Instant::now).elapsed() < Duration::from_secs(60)
}

#[tauri::command]
pub async fn server_test(app: AppHandle, id: String) -> Result<TestResult> {
    let host = load_host(&app, &id)?;
    // CLI-credential hosts keep no secret; the CLI resolves its own credentials.
    let password = host_secret(&host)?;
    // Token hosts SSH with the launcher's key: make sure it exists before checking it.
    if host.provider == Provider::Proxmox && crate::runtime::proxmox::is_token(&host.username) {
        crate::runtime::ssh::ensure_key(&app).await?;
    }
    let mut result = test_host(&host, &password).await;
    // macOS answers the app's first connection to a LAN host after a launch with "no route to
    // host" while it checks the Local Network permission; the next one goes through. One retry
    // keeps every freshly opened app from listing reachable servers as Unreachable.
    // Right after an update (a new binary) that takes longer, so for the app's first minute it
    // keeps trying for about 10 s; later, an unreachable host is reported after one retry.
    if !result.reachable && cfg!(target_os = "macos") {
        let delays: &[u64] = if launched_recently() { &[2, 3, 5] } else { &[2] };
        for secs in delays {
            tokio::time::sleep(Duration::from_secs(*secs)).await;
            result = test_host(&host, &password).await;
            if result.reachable {
                break;
            }
        }
    }
    // GCP: the labs project (created on the first test), which needs a free billing slot.
    if host.provider == Provider::Gcp && result.ok {
        match gcp::labs_project(&app, &id).await {
            Ok(p) => result.checks.push(Check::ok("Labs project", format!("Labs run in the project {p}."))),
            Err(e) => {
                result.checks.push(Check::fail("Labs project", e.to_string()));
                result.ok = false;
            }
        }
    }
    Ok(result)
}

/// The launcher's SSH public key (generated on first use). Token-auth Proxmox hosts must
/// authorize it for the token's SSH user, so the launcher can upload the cloud-init snippet
/// over SSH; the setup form shows it for those hosts.
#[tauri::command]
pub async fn server_public_key(app: AppHandle) -> Result<String> {
    Ok(crate::runtime::ssh::ensure_key(&app).await?.1)
}

/// How many installed labs are currently running on each host, keyed by host id (see
/// `lab_markers`).
#[tauri::command]
pub fn server_running_labs(app: AppHandle) -> HashMap<String, u32> {
    count_by_host(&lab_markers(&app))
}

/// A host's hardware headroom, shown on its row so you can see what it can run.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapacity {
    pub cores: u64,
    pub mem_total: u64,
    pub mem_free: u64,
}

/// Queries a host for its capacity (Proxmox only; cheap API calls). Returns `None` for other
/// providers or if anything fails, so the UI just omits it rather than showing an error.
#[tauri::command]
pub async fn server_capacity(app: AppHandle, id: String) -> Option<HostCapacity> {
    let host = load_host(&app, &id).ok()?;
    if host.provider != Provider::Proxmox {
        return None;
    }
    let password = get_secret(&id).ok()?;
    proxmox_capacity(&host, &password).await
}

async fn proxmox_capacity(h: &HostProfile, password: &str) -> Option<HostCapacity> {
    let session = crate::runtime::proxmox::sign_in(h, password).await.ok()?;
    let node = session.node(h).await.ok()?;
    let d = session.call(&format!("/nodes/{node}/status")).await.ok()?;
    Some(HostCapacity { cores: d["cpuinfo"]["cpus"].as_u64()?, mem_total: d["memory"]["total"].as_u64()?, mem_free: d["memory"]["free"].as_u64()? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_labs_count_per_host_and_skip_blank_markers() {
        let markers: Vec<String> = ["ab", "cd", "ab", ""].iter().map(|s| s.to_string()).collect();
        let counts = count_by_host(&markers);
        assert_eq!(counts.get("ab"), Some(&2));
        assert_eq!(counts.get("cd"), Some(&1));
        assert_eq!(counts.len(), 2);
    }
}
