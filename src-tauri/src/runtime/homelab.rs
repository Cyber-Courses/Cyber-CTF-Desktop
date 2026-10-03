//! Home-lab hosts: the player's own ESXi / Proxmox server, used to run VM labs remotely
//! through Vagrant. Profiles (non-secret) live in `<app data>/homelab.json`; each host's
//! password lives in the OS keychain (a file in debug builds, like the auth session).
//!
//! Neither `vagrant-vmware-esxi` nor `vagrant-proxmox` reads environment variables on its
//! own: a lab's Vagrantfile reads `ENV` and sets `esxi.*` / `proxmox.*` from it. This
//! module defines that contract (`connection_env`), documented in `docs/homelab.md`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

use super::providers::Provider;
use crate::error::{Error, Result};

const STORE_FILE: &str = "homelab.json";
/// Written into a VM lab's directory when it runs on a home-lab host, so stop/status
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
    password: Option<String>,
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
    !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
        && !host.starts_with('-')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn default_port(provider: Provider) -> u16 {
    if provider == Provider::Proxmox { 8006 } else { 22 }
}

fn new_id() -> String {
    (0..8).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

// --- storage --------------------------------------------------------------

fn store_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(STORE_FILE))
}

fn load(app: &AppHandle) -> Result<Store> {
    match std::fs::read_to_string(store_path(app)?) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| Error::Invalid(format!("homelab.json: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.into()),
    }
}

fn save(app: &AppHandle, store: &Store) -> Result<()> {
    let raw = serde_json::to_string_pretty(store).map_err(|e| Error::Invalid(e.to_string()))?;
    std::fs::write(store_path(app)?, raw)?;
    Ok(())
}

fn find(store: &Store, id: &str) -> Result<HostProfile> {
    store.hosts.iter().find(|h| h.id == id).cloned().ok_or_else(|| Error::Invalid(format!("home-lab host `{id}` not found")))
}

// Secrets: keychain in release; a 0600 file in debug, since every `tauri dev` rebuild is
// a new unsigned binary and the keychain would re-prompt on each run (same as auth.rs).

#[cfg(not(debug_assertions))]
fn secret_entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(crate::config::KEYCHAIN_SERVICE, &format!("homelab:{id}")).map_err(|e| Error::Invalid(format!("keychain: {e}")))
}

#[cfg(debug_assertions)]
fn dev_secrets_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or_else(|| Error::Invalid("no home directory".into()))?;
    Ok(PathBuf::from(home).join(".cyberctf").join("dev-homelab-secrets.json"))
}

#[cfg(debug_assertions)]
fn dev_secrets() -> std::collections::BTreeMap<String, String> {
    dev_secrets_path().ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default()
}

#[cfg(debug_assertions)]
fn write_dev_secrets(map: &std::collections::BTreeMap<String, String>) -> Result<()> {
    let path = dev_secrets_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string(map).map_err(|e| Error::Invalid(e.to_string()))?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn get_secret(id: &str) -> Result<String> {
    #[cfg(debug_assertions)]
    let secret = dev_secrets().remove(id);
    #[cfg(not(debug_assertions))]
    let secret = secret_entry(id)?.get_password().ok();
    secret.ok_or_else(|| Error::Invalid("no password stored for this host, edit it and enter one".into()))
}

fn set_secret(id: &str, secret: &str) -> Result<()> {
    #[cfg(debug_assertions)]
    {
        let mut map = dev_secrets();
        map.insert(id.to_string(), secret.to_string());
        write_dev_secrets(&map)
    }
    #[cfg(not(debug_assertions))]
    {
        secret_entry(id)?.set_password(secret).map_err(|e| Error::Invalid(format!("keychain: {e}")))
    }
}

fn delete_secret(id: &str) {
    #[cfg(debug_assertions)]
    {
        let mut map = dev_secrets();
        if map.remove(id).is_some() {
            let _ = write_dev_secrets(&map);
        }
    }
    #[cfg(not(debug_assertions))]
    {
        if let Ok(e) = secret_entry(id) {
            let _ = e.delete_credential();
        }
    }
}

// --- the Vagrantfile contract ---------------------------------------------

/// Environment a lab's Vagrantfile reads to target this host. See `docs/homelab.md`.
/// ESXi Vagrantfiles should use `esxi.esxi_password = "env:CYBERCTF_ESXI_PASSWORD"` so the
/// plugin reads the secret itself.
pub fn connection_env(h: &HostProfile, password: &str) -> Vec<(String, String)> {
    let mut env: Vec<(&str, String)> = vec![("CYBERCTF_REMOTE_PROVIDER", h.provider.id().into()), ("CYBERCTF_REMOTE_HOST", h.host.clone())];
    match h.provider {
        Provider::VmwareEsxi => {
            env.push(("CYBERCTF_ESXI_HOSTNAME", h.host.clone()));
            env.push(("CYBERCTF_ESXI_HOSTPORT", h.port.to_string()));
            env.push(("CYBERCTF_ESXI_USERNAME", h.username.clone()));
            env.push(("CYBERCTF_ESXI_PASSWORD", password.into()));
            if let Some(v) = &h.datastore {
                env.push(("CYBERCTF_ESXI_DISK_STORE", v.clone()));
            }
            if let Some(v) = &h.network {
                env.push(("CYBERCTF_ESXI_VIRTUAL_NETWORK", v.clone()));
            }
        }
        Provider::Proxmox => {
            env.push(("CYBERCTF_PROXMOX_ENDPOINT", proxmox_endpoint(h)));
            env.push(("CYBERCTF_PROXMOX_USER_NAME", h.username.clone()));
            env.push(("CYBERCTF_PROXMOX_PASSWORD", password.into()));
            env.push(("CYBERCTF_PROXMOX_INSECURE", h.insecure_tls.to_string()));
            if let Some(v) = &h.node {
                env.push(("CYBERCTF_PROXMOX_NODE", v.clone()));
            }
            if let Some(v) = &h.datastore {
                env.push(("CYBERCTF_PROXMOX_STORAGE", v.clone()));
            }
            if let Some(v) = &h.network {
                env.push(("CYBERCTF_PROXMOX_BRIDGE", v.clone()));
            }
        }
        _ => {}
    }
    env.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn host_for_url(host: &str) -> String {
    if host.contains(':') { format!("[{host}]") } else { host.to_string() }
}

fn proxmox_endpoint(h: &HostProfile) -> String {
    format!("https://{}:{}/api2/json", host_for_url(&h.host), h.port)
}

/// Terraform variables for a Proxmox host (`deploy/terraform/proxmox`).
pub fn terraform_vars(h: &HostProfile, password: &str) -> Vec<(String, String)> {
    let mut vars = vec![
        ("proxmox_endpoint", format!("https://{}:{}/", host_for_url(&h.host), h.port)),
        ("proxmox_username", h.username.clone()),
        ("proxmox_password", password.to_string()),
        ("proxmox_insecure", h.insecure_tls.to_string()),
        // Snippets go over SSH to the address the player entered.
        ("proxmox_ssh_address", h.host.clone()),
    ];
    if let Some(v) = &h.node {
        vars.push(("proxmox_node", v.clone()));
    }
    if let Some(v) = &h.datastore {
        vars.push(("proxmox_storage", v.clone()));
    }
    if let Some(v) = &h.network {
        vars.push(("proxmox_bridge", v.clone()));
    }
    vars.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// A host resolved for a launch: its provider, the Vagrant env (Vagrantfile contract) and
/// the Terraform variables (Terraform modules).
pub struct Connection {
    pub provider: Provider,
    pub name: String,
    pub env: Vec<(String, String)>,
    pub tf_vars: Vec<(String, String)>,
}

pub fn connection(app: &AppHandle, id: &str) -> Result<Connection> {
    let host = find(&load(app)?, id)?;
    let password = get_secret(id)?;
    Ok(Connection {
        provider: host.provider,
        name: host.name.clone(),
        env: connection_env(&host, &password),
        tf_vars: terraform_vars(&host, &password),
    })
}

/// The host marked as default, if any (used for VM labs launched from the website).
pub fn default_host(app: &AppHandle) -> Option<String> {
    let store = load(app).ok()?;
    store.default.filter(|id| store.hosts.iter().any(|h| &h.id == id))
}

/// Records (or clears) which host a VM lab directory runs on.
pub fn mark_lab(dir: &Path, host: Option<&str>) -> Result<()> {
    let marker = dir.join(HOST_MARKER);
    match host {
        Some(id) => std::fs::write(marker, id)?,
        None => {
            let _ = std::fs::remove_file(marker);
        }
    }
    Ok(())
}

/// The connection a VM lab directory was started with, if it runs on a home-lab host.
pub fn lab_connection(app: &AppHandle, dir: &Path) -> Result<Option<Connection>> {
    match std::fs::read_to_string(dir.join(HOST_MARKER)) {
        Ok(id) => connection(app, id.trim()).map(Some),
        Err(_) => Ok(None),
    }
}

// --- reachability ---------------------------------------------------------

async fn test_host(h: &HostProfile, password: &str) -> TestResult {
    let started = Instant::now();
    let connect = tokio::time::timeout(TEST_TIMEOUT, TcpStream::connect((h.host.as_str(), h.port))).await;
    let mut stream = match connect {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return TestResult { ok: false, reachable: false, authenticated: None, latency_ms: None, message: format!("Can't reach {}:{}: {e}", h.host, h.port) },
        Err(_) => return TestResult { ok: false, reachable: false, authenticated: None, latency_ms: None, message: format!("Timed out reaching {}:{}", h.host, h.port) },
    };
    let latency_ms = Some(started.elapsed().as_millis() as u64);

    match h.provider {
        // vagrant-vmware-esxi drives ESXi over SSH: check the port actually speaks SSH.
        Provider::VmwareEsxi => {
            let mut buf = [0u8; 64];
            let banner = tokio::time::timeout(TEST_TIMEOUT, stream.read(&mut buf)).await;
            match banner {
                Ok(Ok(n)) if buf[..n].starts_with(b"SSH-") => TestResult {
                    ok: true,
                    reachable: true,
                    authenticated: None,
                    latency_ms,
                    message: "SSH is up. Make sure SSH is enabled on the ESXi host; the password is checked on first lab start.".into(),
                },
                _ => TestResult { ok: false, reachable: true, authenticated: None, latency_ms, message: format!("Port {} is open but doesn't answer as SSH. Enable SSH on the ESXi host.", h.port) },
            }
        }
        // Proxmox: log in to the API for a ticket, which verifies the credentials.
        Provider::Proxmox => {
            drop(stream);
            let url = format!("{}/access/ticket", proxmox_endpoint(h));
            let res = reqwest::Client::builder()
                .timeout(TEST_TIMEOUT)
                .tls_danger_accept_invalid_certs(h.insecure_tls)
                .build()
                .map_err(|e| e.to_string())
                .map(|c| c.post(url).form(&[("username", h.username.as_str()), ("password", password)]).send());
            let res = match res {
                Ok(fut) => fut.await,
                Err(e) => return TestResult { ok: false, reachable: true, authenticated: None, latency_ms, message: e },
            };
            match res {
                Ok(r) if r.status().is_success() => TestResult { ok: true, reachable: true, authenticated: Some(true), latency_ms, message: "Connected and signed in to the Proxmox API.".into() },
                Ok(r) if r.status().as_u16() == 401 => TestResult {
                    ok: false,
                    reachable: true,
                    authenticated: Some(false),
                    latency_ms,
                    message: "Proxmox rejected the credentials. Use user@realm, e.g. root@pam.".into(),
                },
                Ok(r) => TestResult { ok: false, reachable: true, authenticated: None, latency_ms, message: format!("Proxmox API answered HTTP {}", r.status()) },
                Err(e) => {
                    let detail = std::iter::successors(Some(&e as &dyn std::error::Error), |e| e.source()).map(|e| e.to_string()).collect::<Vec<_>>().join(": ");
                    let message = if detail.to_lowercase().contains("certificate") {
                        "Reachable, but the host's TLS certificate isn't trusted. Proxmox uses a self-signed certificate by default: turn on \"Self-signed certificate\" for this host, or install a trusted one.".into()
                    } else {
                        format!("Reachable, but the API call failed: {detail}")
                    };
                    TestResult { ok: false, reachable: true, authenticated: None, latency_ms, message }
                }
            }
        }
        _ => TestResult { ok: true, reachable: true, authenticated: None, latency_ms, message: "Reachable".into() },
    }
}

// --- commands -------------------------------------------------------------

#[tauri::command]
pub fn homelab_list(app: AppHandle) -> Result<HostList> {
    let store = load(&app)?;
    Ok(HostList { default: store.default, hosts: store.hosts })
}

/// Creates or updates a host. The first host saved becomes the default.
#[tauri::command]
pub fn homelab_save(app: AppHandle, input: HostInput) -> Result<HostProfile> {
    if !input.provider.is_remote() {
        return Err(Error::Invalid("a home-lab host must be ESXi or Proxmox".into()));
    }
    let host = clean(&input.host, "host", 253)?;
    if !valid_host(&host) {
        return Err(Error::Invalid("host must be a hostname or IP address, without https:// or a path".into()));
    }
    let username = clean(&input.username, "username", 128)?;
    if input.provider == Provider::Proxmox && !username.contains('@') {
        return Err(Error::Invalid("Proxmox users include a realm, e.g. root@pam".into()));
    }
    let mut store = load(&app)?;
    let id = match input.id {
        Some(id) if valid_id(&id) && store.hosts.iter().any(|h| h.id == id) => id,
        Some(_) => return Err(Error::Invalid("unknown home-lab host".into())),
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
    };
    match input.password.filter(|p| !p.is_empty()) {
        Some(p) if p.len() <= 1024 && !p.contains('\0') => set_secret(&id, &p)?,
        Some(_) => return Err(Error::Invalid("invalid password".into())),
        None if get_secret(&id).is_err() => return Err(Error::Invalid("enter the host's password".into())),
        None => {}
    }
    match store.hosts.iter_mut().find(|h| h.id == id) {
        Some(existing) => *existing = profile.clone(),
        None => store.hosts.push(profile.clone()),
    }
    if store.default.is_none() {
        store.default = Some(id);
    }
    save(&app, &store)?;
    Ok(profile)
}

#[tauri::command]
pub fn homelab_remove(app: AppHandle, id: String) -> Result<()> {
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
pub fn homelab_set_default(app: AppHandle, id: Option<String>) -> Result<()> {
    let mut store = load(&app)?;
    if let Some(id) = &id {
        find(&store, id)?;
    }
    store.default = id;
    save(&app, &store)
}

/// Opens the host setup in its own window (label `homelab-setup`); the window closes
/// itself when setup ends. An already open setup window is replaced.
#[tauri::command]
pub async fn homelab_open_setup(app: AppHandle, id: Option<String>) -> Result<()> {
    const LABEL: &str = "homelab-setup";
    let path = match id {
        Some(id) if valid_id(&id) => format!("homelab-setup?id={id}"),
        Some(_) => return Err(Error::Invalid("unknown home-lab host".into())),
        None => "homelab-setup".into(),
    };
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.destroy();
    }
    let mut builder = tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App(path.into()))
        .title("Connect a host")
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
pub async fn homelab_test(app: AppHandle, id: String) -> Result<TestResult> {
    let host = find(&load(&app)?, &id)?;
    let password = get_secret(&id)?;
    Ok(test_host(&host, &password).await)
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
    fn hosts_are_bare_names_or_ips() {
        for good in ["pve.lan", "10.0.0.5", "fd00::5", "esxi-01"] {
            assert!(valid_host(good), "{good}");
        }
        for bad in ["https://pve", "pve/api", "a b", "-x", "pve;rm", ""] {
            assert!(!valid_host(bad), "{bad}");
        }
    }
}
