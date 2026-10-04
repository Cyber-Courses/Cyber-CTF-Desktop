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

/// Cloud labs stop themselves after this long unless the account says otherwise.
pub const DEFAULT_AUTO_STOP_HOURS: u32 = 4;

fn default_port(provider: Provider) -> u16 {
    match provider {
        Provider::Proxmox => 8006,
        Provider::Aws => 443,
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

/// An AWS access key id (AKIA... long-term, ASIA... temporary).
fn valid_access_key_id(id: &str) -> bool {
    (16..=128).contains(&id.len()) && id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// The Terraform target (deploy/terraform/<target>) for a provider, if it uses Terraform.
pub fn terraform_target(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Proxmox => Some("proxmox"),
        Provider::Aws => Some("aws"),
        _ => None,
    }
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
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| Error::Invalid(format!("server.json: {e}"))),
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
    store.hosts.iter().find(|h| h.id == id).cloned().ok_or_else(|| Error::Invalid(format!("server host `{id}` not found")))
}

// Secrets: keychain in release; a 0600 file in debug, since every `tauri dev` rebuild is
// a new unsigned binary and the keychain would re-prompt on each run (same as auth.rs).

#[cfg(not(debug_assertions))]
fn secret_entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(crate::config::KEYCHAIN_SERVICE, &format!("server:{id}")).map_err(|e| Error::Invalid(format!("keychain: {e}")))
}

#[cfg(debug_assertions)]
fn dev_secrets_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or_else(|| Error::Invalid("no home directory".into()))?;
    Ok(PathBuf::from(home).join(".cyberctf").join("dev-server-secrets.json"))
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

/// Environment a lab's Vagrantfile reads to target this host. See `docs/server.md`.
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

/// Raw environment for Terraform (credentials the provider reads itself, never variables).
pub fn terraform_env(h: &HostProfile, password: &str) -> Vec<(String, String)> {
    match h.provider {
        // CLI credentials: pass the region (and the chosen profile); Terraform reads the AWS
        // CLI's chain (works with a local terraform, which has the host's ~/.aws).
        Provider::Aws if h.use_cli_creds => {
            let mut env = vec![("AWS_REGION".to_string(), h.host.clone())];
            if let Some(p) = &h.aws_profile {
                env.push(("AWS_PROFILE".to_string(), p.clone()));
            }
            env
        }
        Provider::Aws => vec![
            ("AWS_ACCESS_KEY_ID".into(), h.username.clone()),
            ("AWS_SECRET_ACCESS_KEY".into(), password.to_string()),
            ("AWS_REGION".into(), h.host.clone()),
        ],
        _ => Vec::new(),
    }
}

/// Terraform variables for a host (`deploy/terraform/<target>`).
pub fn terraform_vars(h: &HostProfile, password: &str) -> Vec<(String, String)> {
    if h.provider == Provider::Aws {
        let mut vars = vec![
            ("region".to_string(), h.host.clone()),
            ("auto_stop_hours".to_string(), h.auto_stop_hours.unwrap_or(DEFAULT_AUTO_STOP_HOURS).to_string()),
        ];
        if let Some(t) = &h.datastore {
            vars.push(("instance_type".into(), t.clone()));
        }
        return vars;
    }
    let mut vars = vec![
        ("proxmox_endpoint", format!("https://{}:{}/", host_for_url(&h.host), h.port)),
        ("proxmox_username", super::proxmox::token_user(&h.username).to_string()),
        ("proxmox_insecure", h.insecure_tls.to_string()),
        // Snippets go over SSH to the address the player entered.
        ("proxmox_ssh_address", h.host.clone()),
    ];
    // An API token replaces the password for the API; the snippet upload then uses the
    // launcher's SSH key (added at apply time, see terraform.rs).
    if super::proxmox::is_token(&h.username) {
        vars.push(("proxmox_api_token", super::proxmox::terraform_token(&h.username, password)));
        vars.push(("proxmox_ssh_username", super::proxmox::ssh_user(&h.username).to_string()));
    } else {
        vars.push(("proxmox_password", password.to_string()));
    }
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
    /// Raw env for the Terraform container (cloud credentials).
    pub tf_env: Vec<(String, String)>,
}

pub fn connection(app: &AppHandle, id: &str) -> Result<Connection> {
    let host = find(&load(app)?, id)?;
    // CLI-credential hosts keep no secret; Terraform uses the AWS CLI's default chain.
    let password = if host.use_cli_creds { String::new() } else { get_secret(id)? };
    Ok(Connection {
        provider: host.provider,
        name: host.name.clone(),
        env: connection_env(&host, &password),
        tf_vars: terraform_vars(&host, &password),
        tf_env: terraform_env(&host, &password),
    })
}

/// The player's hosts and cloud accounts as launch targets for the website
/// (`{ id, name, provider }`), reported by the launcher agent.
pub fn launch_targets(app: &AppHandle) -> Vec<serde_json::Value> {
    load(app)
        .map(|s| s.hosts.iter().map(|h| serde_json::json!({ "id": h.id, "name": h.name, "provider": h.provider.id() })).collect())
        .unwrap_or_default()
}

/// A host's display name, if it exists.
pub fn host_name(app: &AppHandle, id: &str) -> Option<String> {
    load(app).ok()?.hosts.into_iter().find(|h| h.id == id).map(|h| h.name)
}

/// The host marked as default, if any (used for VM labs launched from the website).
pub fn default_host(app: &AppHandle) -> Option<String> {
    let store = load(app).ok()?;
    // Only server hosts: a cloud account is never used implicitly (it costs money).
    store.default.filter(|id| store.hosts.iter().any(|h| &h.id == id && h.provider != Provider::Aws))
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

/// The connection a VM lab directory was started with, if it runs on a server host.
pub fn lab_connection(app: &AppHandle, dir: &Path) -> Result<Option<Connection>> {
    match std::fs::read_to_string(dir.join(HOST_MARKER)) {
        Ok(id) => connection(app, id.trim()).map(Some),
        Err(_) => Ok(None),
    }
}

// --- reachability ---------------------------------------------------------

/// Runs an aws subcommand the way this host connects: the host CLI (CLI credentials), or the
/// official CLI container with the keys in its environment (Docker is the floor).
async fn aws_cmd(h: &HostProfile, env: &[(String, String)], sub: &[&str]) -> Result<String> {
    if h.use_cli_creds {
        crate::exec::run_env("aws", sub, None, env).await
    } else {
        let mut args = vec!["run", "--rm", "-e", "AWS_ACCESS_KEY_ID", "-e", "AWS_SECRET_ACCESS_KEY", "-e", "AWS_REGION", "amazon/aws-cli:2.37.9"];
        args.extend_from_slice(sub);
        crate::exec::run_env("docker", &args, None, env).await
    }
}

/// AWS: verify the credentials work (`sts get-caller-identity`) and that they can actually
/// launch EC2 (`ec2 run-instances --dry-run`, which creates nothing but checks the permission).
async fn test_aws(h: &HostProfile, password: &str) -> TestResult {
    let started = Instant::now();
    let env = terraform_env(h, password);
    let arn = match aws_cmd(h, &env, &["sts", "get-caller-identity", "--query", "Arn", "--output", "text"]).await {
        Ok(a) => a.trim().to_string(),
        Err(Error::CommandFailed { stderr, .. }) => {
            let denied = stderr.contains("InvalidClientTokenId")
                || stderr.contains("SignatureDoesNotMatch")
                || stderr.contains("AccessDenied")
                || stderr.contains("Unable to locate credentials")
                || stderr.contains("sso");
            return TestResult {
                ok: false,
                reachable: true,
                authenticated: denied.then_some(false),
                latency_ms: None,
                message: if denied {
                    "AWS rejected these credentials, or the profile isn't signed in.".into()
                } else {
                    format!("AWS check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            };
        }
        Err(e) => return TestResult { ok: false, reachable: false, authenticated: None, latency_ms: None, message: format!("AWS check failed: {e}") },
    };
    // Can this identity launch EC2? A dry run creates nothing; it only checks the permission.
    let dry = aws_cmd(h, &env, &["ec2", "run-instances", "--dry-run", "--instance-type", "t3.micro", "--image-id", "ami-00000000000000000", "--output", "text"]).await;
    let latency = Some(started.elapsed().as_millis() as u64);
    let stderr = match &dry {
        Err(Error::CommandFailed { stderr, .. }) => stderr.clone(),
        _ => String::new(),
    };
    if stderr.contains("UnauthorizedOperation") {
        return TestResult {
            ok: false,
            reachable: true,
            authenticated: Some(true),
            latency_ms: latency,
            message: format!("Signed in as {arn}, but this identity can't launch EC2 (ec2:RunInstances is denied). Add EC2 permissions to it."),
        };
    }
    TestResult {
        ok: true,
        reachable: true,
        authenticated: Some(true),
        latency_ms: latency,
        message: format!("Signed in as {arn}, and able to launch EC2. Labs run here are billed to this account."),
    }
}

/// This month's AWS spend so far (USD) for a host, via Cost Explorer. None if unreadable.
async fn month_to_date_cost(h: &HostProfile, password: &str) -> Option<f64> {
    let env = terraform_env(h, password);
    let period = crate::cloud::month_period();
    let out = aws_cmd(
        h,
        &env,
        &["ce", "get-cost-and-usage", "--time-period", period.as_str(), "--granularity", "MONTHLY", "--metrics", "UnblendedCost", "--query", "ResultsByTime[0].Total.UnblendedCost.Amount", "--output", "text"],
    )
    .await
    .ok()?;
    out.trim().parse::<f64>().ok()
}

/// `(spent, limit)` when an AWS account is at or over its monthly budget; None otherwise
/// (no budget, under it, not AWS, or the spend couldn't be read). Used to block a launch.
pub async fn budget_exceeded(app: &AppHandle, id: &str) -> Option<(f64, f64)> {
    let host = find(&load(app).ok()?, id).ok()?;
    if host.provider != Provider::Aws {
        return None;
    }
    let limit = host.monthly_limit.filter(|v| *v > 0.0)?;
    let password = if host.use_cli_creds { String::new() } else { get_secret(id).ok()? };
    let spent = month_to_date_cost(&host, &password).await?;
    (spent >= limit).then_some((spent, limit))
}

async fn test_host(h: &HostProfile, password: &str) -> TestResult {
    if h.provider == Provider::Aws {
        return test_aws(h, password).await;
    }
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
        // Proxmox: sign in to the API (token or user + password), then check what a lab
        // launch needs (node, storage content, bridge, SSH key for token setups).
        Provider::Proxmox => {
            drop(stream);
            let r = super::proxmox::test(h, password).await;
            TestResult { ok: r.ok, reachable: true, authenticated: r.authenticated, latency_ms, message: r.message }
        }
        _ => TestResult { ok: true, reachable: true, authenticated: None, latency_ms, message: "Reachable".into() },
    }
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
        return Err(Error::Invalid("a host must be ESXi, Proxmox or AWS".into()));
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
            Provider::Aws => match input.auto_stop_hours.unwrap_or(DEFAULT_AUTO_STOP_HOURS) {
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
        None if !use_cli && get_secret(&id).is_err() => return Err(Error::Invalid("enter the host's password".into())),
        None => {}
    }
    match store.hosts.iter_mut().find(|h| h.id == id) {
        Some(existing) => *existing = profile.clone(),
        None => store.hosts.push(profile.clone()),
    }
    if store.default.is_none() && profile.provider != Provider::Aws {
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
    if let Some(id) = &id {
        if find(&store, id)?.provider == Provider::Aws {
            return Err(Error::Invalid("a cloud account can't be the default host".into()));
        }
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
    let password = if host.use_cli_creds { String::new() } else { get_secret(&id)? };
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
    Some(HostCapacity {
        cores: d["cpuinfo"]["cpus"].as_u64()?,
        mem_total: d["memory"]["total"].as_u64()?,
        mem_free: d["memory"]["free"].as_u64()?,
    })
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
        let h = HostProfile { provider: Provider::Aws, host: "eu-west-3".into(), username: "AKIAIOSFODNN7EXAMPLE".into(), datastore: Some("t3.small".into()), ..profile(Provider::Proxmox) };
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
