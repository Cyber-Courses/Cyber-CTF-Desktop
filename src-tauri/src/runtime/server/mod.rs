//! Server hosts: the player's own ESXi / Proxmox server, used to run VM labs remotely
//! through Vagrant. Profiles (non-secret) live in `<app data>/server.json`; each host's
//! password lives in the OS keychain (a file in debug builds, like the auth session).
//!
//! Neither `vagrant-vmware-esxi` nor `vagrant-proxmox` reads environment variables on its
//! own: a lab's Vagrantfile reads `ENV` and sets `esxi.*` / `proxmox.*` from it. This
//! module defines that contract (`connection_env`), documented in `docs/server.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

use super::providers::Provider;
use crate::error::{Error, Result};

const STORE_FILE: &str = "server.json";
/// Written into a VM lab's directory when it runs on a server host, so stop/status
/// (which re-evaluate the Vagrantfile) get the same connection.
const HOST_MARKER: &str = ".cyberctf-host";
const TEST_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    /// Display name, e.g. "Garage Proxmox".
    pub name: String,
    /// `vmware_esxi` or `proxmox`.
    pub provider: Provider,
    /// Hostname or IP, no scheme.
    pub host: String,
    /// ESXi: SSH port (22). Proxmox: API port (8006).
    pub port: u16,
    /// ESXi: e.g. `root`. Proxmox: user with realm, e.g. `root@pam`.
    pub username: String,
    /// ESXi datastore / Proxmox storage for lab disks.
    #[serde(default)]
    pub datastore: Option<String>,
    /// ESXi port group / Proxmox bridge for lab NICs.
    #[serde(default)]
    pub network: Option<String>,
    /// Proxmox node name.
    #[serde(default)]
    pub node: Option<String>,
    /// Proxmox: accept the API's self-signed certificate (the Proxmox default).
    #[serde(default)]
    pub insecure_tls: bool,
    /// AWS: terminate a lab's instance this many hours after it starts (0 = never).
    #[serde(default)]
    pub auto_stop_hours: Option<u32>,
    /// AWS: use the AWS CLI's own credentials (the default chain, from `aws configure`)
    /// instead of access keys stored by the launcher. No secret is kept in the keychain.
    #[serde(default)]
    pub use_cli_creds: bool,
    /// AWS CLI profile to use with `use_cli_creds` (None = the default profile).
    #[serde(default)]
    pub aws_profile: Option<String>,
    /// AWS: a monthly spend limit in USD; new cloud labs are blocked once this month's
    /// cost passes it. None / 0 = no limit.
    #[serde(default)]
    pub monthly_limit: Option<f64>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    default: Option<String>,
    hosts: Vec<HostProfile>,
}

/// What the UI submits. `id` is None for a new host; `password` None keeps the stored one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    id: Option<String>,
    name: String,
    provider: Provider,
    host: String,
    port: Option<u16>,
    username: String,
    datastore: Option<String>,
    network: Option<String>,
    node: Option<String>,
    insecure_tls: Option<bool>,
    auto_stop_hours: Option<u32>,
    password: Option<String>,
    #[serde(default)]
    use_cli_creds: Option<bool>,
    #[serde(default)]
    aws_profile: Option<String>,
    #[serde(default)]
    monthly_limit: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostList {
    default: Option<String>,
    hosts: Vec<HostProfile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    /// Everything checked passed: the host looks usable for labs.
    ok: bool,
    /// Host:port accepted a TCP connection.
    reachable: bool,
    /// Credentials verified (Proxmox API login). None when not checked (ESXi: SSH auth
    /// is only exercised by Vagrant itself).
    authenticated: Option<bool>,
    latency_ms: Option<u64>,
    message: String,
}

mod contract;
mod reachability;
mod store;

pub use contract::*;
pub use reachability::*;
use store::*;

// --- validation -----------------------------------------------------------

fn clean(value: &str, field: &str, max: usize) -> Result<String> {
    let v = value.trim();
    if v.is_empty() || v.len() > max || v.chars().any(char::is_control) {
        return Err(Error::Invalid(format!("invalid {field}")));
    }
    Ok(v.to_string())
}

fn clean_opt(value: Option<String>, field: &str) -> Result<Option<String>> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => clean(v, field, 128).map(Some),
    }
}

/// A bare hostname or IP (v4 or v6), never a URL: it is interpolated into an endpoint.
fn valid_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 253 && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c)) && !host.starts_with('-')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// Cloud labs stop themselves after this long unless the account says otherwise.
pub const DEFAULT_AUTO_STOP_HOURS: u32 = 4;

fn default_port(provider: Provider) -> u16 {
    match provider {
        Provider::Proxmox => 8006,
        Provider::Aws | Provider::Azure | Provider::Gcp => 443,
        _ => 22,
    }
}

/// An AWS region id, e.g. eu-west-3, us-gov-west-1.
fn valid_region(region: &str) -> bool {
    let parts: Vec<&str> = region.split('-').collect();
    parts.len() >= 3
        && parts[0].len() == 2
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
        && parts.last().is_some_and(|p| p.chars().all(|c| c.is_ascii_digit()))
}

/// An Azure location id, e.g. "westeurope" (lowercase letters/digits, no spaces).
fn valid_azure_location(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// An Azure subscription id (a GUID, 8-4-4-4-12 hex).
fn valid_subscription(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    p.len() == 5 && [8usize, 4, 4, 4, 12].iter().zip(&p).all(|(n, seg)| seg.len() == *n && seg.chars().all(|c| c.is_ascii_hexdigit()))
}

/// A GCP region id, e.g. "europe-west1", "us-central1" (lowercase letters/digits with a hyphen).
fn valid_gcp_region(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.contains('-') && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A GCP project id: 6-30 chars, starts with a lowercase letter, then lowercase letters,
/// digits or hyphens, and does not end with a hyphen.
fn valid_gcp_project(s: &str) -> bool {
    (6..=30).contains(&s.len())
        && s.starts_with(|c: char| c.is_ascii_lowercase())
        && !s.ends_with('-')
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// An AWS access key id (AKIA... long-term, ASIA... temporary).
fn valid_access_key_id(id: &str) -> bool {
    (16..=128).contains(&id.len()) && id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// The Terraform target (deploy/terraform/<target>) for a provider, if it uses Terraform.
pub fn terraform_target(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Proxmox => Some("proxmox"),
        Provider::Aws => Some("aws"),
        Provider::Azure => Some("azure"),
        Provider::Gcp => Some("gcp"),
        _ => None,
    }
}

fn new_id() -> String {
    (0..8).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

// --- commands -------------------------------------------------------------

#[tauri::command]
pub fn server_list(app: AppHandle) -> Result<HostList> {
    let store = load(&app)?;
    Ok(HostList { default: store.default, hosts: store.hosts })
}

/// Creates or updates a host. The first host saved becomes the default.
#[tauri::command]
pub fn server_save(app: AppHandle, input: HostInput) -> Result<HostProfile> {
    if !input.provider.is_remote() {
        return Err(Error::Invalid("a host must be ESXi, Proxmox, AWS, Azure or GCP".into()));
    }
    let host = clean(&input.host, "host", 253)?;
    // AWS can connect with the AWS CLI's own credentials instead of stored keys.
    let use_cli = input.provider == Provider::Aws && input.use_cli_creds.unwrap_or(false);
    let username = if use_cli { String::new() } else { clean(&input.username, "username", 128)? };
    if input.provider == Provider::Aws {
        if !valid_region(&host) {
            return Err(Error::Invalid("region must be an AWS region id, e.g. eu-west-3".into()));
        }
        if !use_cli && !valid_access_key_id(&username) {
            return Err(Error::Invalid("access key id looks wrong (AKIA... or ASIA...)".into()));
        }
    } else if input.provider == Provider::Azure {
        if !valid_azure_location(&host) {
            return Err(Error::Invalid("region must be an Azure location, e.g. westeurope".into()));
        }
        if !valid_subscription(&username) {
            return Err(Error::Invalid("subscription must be a GUID (see `az account show`)".into()));
        }
    } else if input.provider == Provider::Gcp {
        if !valid_gcp_region(&host) {
            return Err(Error::Invalid("region must be a GCP region id, e.g. europe-west1".into()));
        }
        if !valid_gcp_project(&username) {
            return Err(Error::Invalid("project must be a GCP project id, e.g. my-lab-project".into()));
        }
    } else if !valid_host(&host) {
        return Err(Error::Invalid("host must be a hostname or IP address, without https:// or a path".into()));
    }
    if input.provider == Provider::Proxmox && !username.contains('@') {
        return Err(Error::Invalid("Proxmox users include a realm, e.g. root@pam".into()));
    }
    let mut store = load(&app)?;
    let id = match input.id {
        Some(id) if valid_id(&id) && store.hosts.iter().any(|h| h.id == id) => id,
        Some(_) => return Err(Error::Invalid("unknown server host".into())),
        None => new_id(),
    };
    let profile = HostProfile {
        id: id.clone(),
        name: clean(&input.name, "name", 64)?,
        provider: input.provider,
        host,
        port: input.port.filter(|p| *p > 0).unwrap_or(default_port(input.provider)),
        username,
        datastore: clean_opt(input.datastore, "datastore")?,
        network: clean_opt(input.network, "network")?,
        node: if input.provider == Provider::Proxmox { clean_opt(input.node, "node")? } else { None },
        insecure_tls: input.provider == Provider::Proxmox && input.insecure_tls.unwrap_or(false),
        auto_stop_hours: match input.provider {
            Provider::Aws | Provider::Azure | Provider::Gcp => match input.auto_stop_hours.unwrap_or(DEFAULT_AUTO_STOP_HOURS) {
                h if h <= 72 => Some(h),
                _ => return Err(Error::Invalid("auto-stop must be between 0 and 72 hours".into())),
            },
            _ => None,
        },
        use_cli_creds: use_cli,
        aws_profile: if use_cli { clean_opt(input.aws_profile, "profile")? } else { None },
        monthly_limit: input.monthly_limit.filter(|v| *v > 0.0),
    };
    match input.password.filter(|p| !p.is_empty()) {
        Some(p) if p.len() <= 1024 && !p.contains('\0') => set_secret(&id, &p)?,
        Some(_) => return Err(Error::Invalid("invalid password".into())),
        None if !use_cli && !matches!(input.provider, Provider::Azure | Provider::Gcp) && get_secret(&id).is_err() => {
            return Err(Error::Invalid("enter the host's password".into()));
        }
        None => {}
    }
    match store.hosts.iter_mut().find(|h| h.id == id) {
        Some(existing) => *existing = profile.clone(),
        None => store.hosts.push(profile.clone()),
    }
    if store.default.is_none() && !matches!(profile.provider, Provider::Aws | Provider::Azure | Provider::Gcp) {
        store.default = Some(id);
    }
    save(&app, &store)?;
    Ok(profile)
}

#[tauri::command]
pub fn server_remove(app: AppHandle, id: String) -> Result<()> {
    let mut store = load(&app)?;
    store.hosts.retain(|h| h.id != id);
    if store.default.as_deref() == Some(id.as_str()) {
        store.default = store.hosts.first().map(|h| h.id.clone());
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
        && matches!(find(&store, id)?.provider, Provider::Aws | Provider::Azure | Provider::Gcp)
    {
        return Err(Error::Invalid("a cloud account can't be the default host".into()));
    }
    store.default = id;
    save(&app, &store)
}

/// Opens the host setup in its own window (label `server-setup`); the window closes
/// itself when setup ends. An already open setup window is replaced.
#[tauri::command]
pub async fn server_open_setup(app: AppHandle, id: Option<String>, kind: Option<String>) -> Result<()> {
    const LABEL: &str = "server-setup";
    let cloud = kind.as_deref() == Some("cloud");
    let path = match id {
        Some(id) if valid_id(&id) => format!("server-setup?id={id}"),
        Some(_) => return Err(Error::Invalid("unknown server host".into())),
        None if cloud => "server-setup?kind=cloud".into(),
        None => "server-setup".into(),
    };
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.destroy();
    }
    let mut builder = tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App(path.into()))
        .title(if cloud { "Connect AWS" } else { "Connect a host" })
        .inner_size(680.0, 760.0)
        .min_inner_size(560.0, 560.0)
        .resizable(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| Error::Invalid(e.to_string()))?;
    }
    builder.build().map_err(|e| Error::Invalid(format!("could not open the setup window: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn server_test(app: AppHandle, id: String) -> Result<TestResult> {
    let host = find(&load(&app)?, &id)?;
    // CLI-credential hosts keep no secret; the CLI resolves its own credentials.
    let password = if host.use_cli_creds || matches!(host.provider, Provider::Azure | Provider::Gcp) { String::new() } else { get_secret(&id)? };
    // Token hosts SSH with the launcher's key: make sure it exists before checking it.
    if host.provider == Provider::Proxmox && super::proxmox::is_token(&host.username) {
        super::ssh::ensure_key(&app).await?;
    }
    Ok(test_host(&host, &password).await)
}

/// How many installed labs are currently running on each host, keyed by host id. A lab
/// leaves a `.cyberctf-host` marker in its directory while it runs on a host (written on
/// start, cleared on stop), so this is filesystem-only: no host calls, no credentials.
#[tauri::command]
pub fn server_running_labs(app: AppHandle) -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    let Ok(labs) = app.path().app_data_dir().map(|d| d.join("labs")) else { return counts };
    if let Ok(entries) = std::fs::read_dir(labs) {
        for e in entries.flatten() {
            if let Ok(id) = std::fs::read_to_string(e.path().join(HOST_MARKER)) {
                let id = id.trim();
                if !id.is_empty() {
                    *counts.entry(id.to_string()).or_default() += 1;
                }
            }
        }
    }
    counts
}

/// A host's hardware headroom, shown on its row so you can see what it can run.
#[derive(serde::Serialize)]
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
    let host = find(&load(&app).ok()?, &id).ok()?;
    if host.provider != Provider::Proxmox {
        return None;
    }
    let password = get_secret(&id).ok()?;
    proxmox_capacity(&host, &password).await
}

async fn proxmox_capacity(h: &HostProfile, password: &str) -> Option<HostCapacity> {
    let session = super::proxmox::sign_in(h, password).await.ok()?;
    let node = session.node(h).await.ok()?;
    let d = session.call(&format!("/nodes/{node}/status")).await.ok()?;
    Some(HostCapacity { cores: d["cpuinfo"]["cpus"].as_u64()?, mem_total: d["memory"]["total"].as_u64()?, mem_free: d["memory"]["free"].as_u64()? })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(provider: Provider) -> HostProfile {
        HostProfile {
            id: "ab12".into(),
            name: "Lab".into(),
            provider,
            host: "10.0.0.5".into(),
            port: default_port(provider),
            username: if provider == Provider::Proxmox { "root@pam".into() } else { "root".into() },
            datastore: Some("ssd1".into()),
            network: Some("vmbr1".into()),
            node: Some("pve".into()),
            insecure_tls: false,
            auto_stop_hours: None,
            use_cli_creds: false,
            aws_profile: None,
            monthly_limit: None,
        }
    }

    fn get<'a>(env: &'a [(String, String)], k: &str) -> Option<&'a str> {
        env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn esxi_env_contract() {
        let env = connection_env(&profile(Provider::VmwareEsxi), "s3cret");
        assert_eq!(get(&env, "CYBERCTF_REMOTE_PROVIDER"), Some("vmware_esxi"));
        assert_eq!(get(&env, "CYBERCTF_ESXI_HOSTNAME"), Some("10.0.0.5"));
        assert_eq!(get(&env, "CYBERCTF_ESXI_HOSTPORT"), Some("22"));
        assert_eq!(get(&env, "CYBERCTF_ESXI_PASSWORD"), Some("s3cret"));
        assert_eq!(get(&env, "CYBERCTF_ESXI_DISK_STORE"), Some("ssd1"));
        assert!(get(&env, "CYBERCTF_PROXMOX_ENDPOINT").is_none());
    }

    #[test]
    fn proxmox_env_contract() {
        let mut p = profile(Provider::Proxmox);
        assert_eq!(get(&connection_env(&p, "x"), "CYBERCTF_PROXMOX_ENDPOINT"), Some("https://10.0.0.5:8006/api2/json"));
        p.host = "fd00::5".into();
        let env = connection_env(&p, "x");
        assert_eq!(get(&env, "CYBERCTF_PROXMOX_ENDPOINT"), Some("https://[fd00::5]:8006/api2/json"));
        assert_eq!(get(&env, "CYBERCTF_PROXMOX_USER_NAME"), Some("root@pam"));
        assert_eq!(get(&env, "CYBERCTF_PROXMOX_NODE"), Some("pve"));
        assert_eq!(get(&env, "CYBERCTF_PROXMOX_BRIDGE"), Some("vmbr1"));
    }

    #[test]
    fn aws_regions_and_keys() {
        for good in ["eu-west-3", "us-east-1", "us-gov-west-1", "ap-southeast-2"] {
            assert!(valid_region(good), "{good}");
        }
        for bad in ["eu-west", "EU-west-3", "eu_west_3", "https://eu-west-3", "eu-west-3a"] {
            assert!(!valid_region(bad), "{bad}");
        }
        assert!(valid_access_key_id("AKIAIOSFODNN7EXAMPLE"));
        assert!(!valid_access_key_id("akiaiosfodnn7example"));
        let h = HostProfile {
            provider: Provider::Aws,
            host: "eu-west-3".into(),
            username: "AKIAIOSFODNN7EXAMPLE".into(),
            datastore: Some("t3.small".into()),
            ..profile(Provider::Proxmox)
        };
        assert_eq!(get(&terraform_env(&h, "sec"), "AWS_SECRET_ACCESS_KEY"), Some("sec"));
        let vars = terraform_vars(&h, "sec");
        assert_eq!(get(&vars, "region"), Some("eu-west-3"));
        assert!(get(&vars, "proxmox_password").is_none());
    }

    #[test]
    fn hosts_are_bare_names_or_ips() {
        for good in ["pve.lan", "10.0.0.5", "fd00::5", "esxi-01"] {
            assert!(valid_host(good), "{good}");
        }
        for bad in ["https://pve", "pve/api", "a b", "-x", "pve;rm", ""] {
            assert!(!valid_host(bad), "{bad}");
        }
    }
}
