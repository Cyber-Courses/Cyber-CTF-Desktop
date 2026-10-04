//! What a lab is given to reach its server: the env a Vagrantfile reads, Terraform's env
//! and variables, and which server a lab directory is tied to.

use super::*;

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

pub(super) fn host_for_url(host: &str) -> String {
    if host.contains(':') { format!("[{host}]") } else { host.to_string() }
}

pub(super) fn proxmox_endpoint(h: &HostProfile) -> String {
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
        // azurerm uses the Azure CLI's auth (az login); it only needs the subscription id.
        Provider::Azure => vec![("ARM_SUBSCRIPTION_ID".to_string(), h.username.clone())],
        _ => Vec::new(),
    }
}

/// Terraform variables for a host (`deploy/terraform/<target>`).
pub fn terraform_vars(h: &HostProfile, password: &str) -> Vec<(String, String)> {
    if h.provider == Provider::Aws || h.provider == Provider::Azure {
        let mut vars =
            vec![("region".to_string(), h.host.clone()), ("auto_stop_hours".to_string(), h.auto_stop_hours.unwrap_or(DEFAULT_AUTO_STOP_HOURS).to_string())];
        if let Some(t) = &h.datastore {
            vars.push(("instance_type".into(), t.clone()));
        }
        return vars;
    }
    let mut vars = vec![
        ("proxmox_endpoint", format!("https://{}:{}/", host_for_url(&h.host), h.port)),
        ("proxmox_username", crate::runtime::proxmox::token_user(&h.username).to_string()),
        ("proxmox_insecure", h.insecure_tls.to_string()),
        // Snippets go over SSH to the address the player entered.
        ("proxmox_ssh_address", h.host.clone()),
    ];
    // An API token replaces the password for the API; the snippet upload then uses the
    // launcher's SSH key (added at apply time, see terraform.rs).
    if crate::runtime::proxmox::is_token(&h.username) {
        vars.push(("proxmox_api_token", crate::runtime::proxmox::terraform_token(&h.username, password)));
        vars.push(("proxmox_ssh_username", crate::runtime::proxmox::ssh_user(&h.username).to_string()));
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
    let password = if host.use_cli_creds || host.provider == Provider::Azure { String::new() } else { get_secret(id)? };
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
    load(app).map(|s| s.hosts.iter().map(|h| serde_json::json!({ "id": h.id, "name": h.name, "provider": h.provider.id() })).collect()).unwrap_or_default()
}

/// A host's display name, if it exists.
pub fn host_name(app: &AppHandle, id: &str) -> Option<String> {
    load(app).ok()?.hosts.into_iter().find(|h| h.id == id).map(|h| h.name)
}

/// The host marked as default, if any (used for VM labs launched from the website).
pub fn default_host(app: &AppHandle) -> Option<String> {
    let store = load(app).ok()?;
    // Only server hosts: a cloud account is never used implicitly (it costs money).
    store.default.filter(|id| store.hosts.iter().any(|h| &h.id == id && !matches!(h.provider, Provider::Aws | Provider::Azure)))
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
