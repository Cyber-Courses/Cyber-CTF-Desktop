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
            // The names Isoloom's Vagrantfiles read (the plugin reads the password itself).
            env.push(("ESXI_HOSTNAME", h.host.clone()));
            env.push(("ESXI_HOSTPORT", h.port.to_string()));
            env.push(("ESXI_USERNAME", h.username.clone()));
            env.push(("ESXI_PASSWORD", password.into()));
            if let Some(v) = &h.datastore {
                env.push(("ESXI_DATASTORE", v.clone()));
            }
            if let Some(v) = &h.network {
                env.push(("ESXI_VIRTUAL_NETWORK", v.clone()));
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
        // The google provider uses gcloud's ADC. The per-lab project is created inside the
        // module (from the billing account / org passed as vars), so there's no GOOGLE_PROJECT.
        Provider::Gcp => Vec::new(),
        // The digitalocean provider reads DIGITALOCEAN_TOKEN (the stored API token).
        Provider::DigitalOcean => vec![("DIGITALOCEAN_TOKEN".to_string(), password.to_string())],
        // The linode provider reads LINODE_TOKEN (the stored API token).
        Provider::Linode => vec![("LINODE_TOKEN".to_string(), password.to_string())],
        _ => Vec::new(),
    }
}

/// Terraform variables for a host (the variables of Isoloom's modules).
pub fn terraform_vars(h: &HostProfile, password: &str) -> Vec<(String, String)> {
    if matches!(h.provider, Provider::Aws | Provider::Azure | Provider::Gcp | Provider::DigitalOcean | Provider::Linode | Provider::Oci) {
        let hours = h.auto_stop_hours.unwrap_or(DEFAULT_AUTO_STOP_HOURS);
        // `auto_stop_hours` is the launcher's own (expiry, reaper); Isoloom's modules take minutes.
        let mut vars = vec![
            ("region".to_string(), h.host.clone()),
            ("auto_stop_hours".to_string(), hours.to_string()),
            ("auto_stop_minutes".to_string(), (hours * 60).to_string()),
        ];
        // The size, under each module's own variable name.
        if let Some(t) = &h.datastore {
            let name = match h.provider {
                Provider::Azure | Provider::DigitalOcean => "size",
                Provider::Gcp => "machine_type",
                Provider::Linode => "type",
                _ => "instance_type",
            };
            vars.push((name.into(), t.clone()));
        }
        // GCP: the account's labs project (see `gcp`), else a project per lab from the billing
        // account (the module creates and deletes it).
        if h.provider == Provider::Gcp {
            match &h.gcp_project {
                Some(p) => vars.push(("project".into(), p.clone())),
                None => {
                    vars.push(("billing_account".into(), h.username.clone()));
                    if let Some(org) = &h.node {
                        vars.push(("org_id".into(), org.clone()));
                    }
                }
            }
        }
        // OCI deploys into a compartment (the tenancy root works).
        if h.provider == Provider::Oci {
            vars.push(("compartment_id".into(), h.username.clone()));
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
    // Isoloom's Proxmox variables.
    if let Some(v) = &h.node {
        vars.push(("node", v.clone()));
    }
    if let Some(v) = &h.datastore {
        vars.push(("datastore", v.clone()));
    }
    if let Some(v) = &h.network {
        vars.push(("uplink_bridge", v.clone()));
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
    /// Raw environment for Terraform (cloud credentials the provider reads itself).
    pub tf_env: Vec<(String, String)>,
}

pub fn connection(app: &AppHandle, id: &str) -> Result<Connection> {
    let host = find(&load(app)?, id)?;
    // CLI-credential hosts keep no secret; Terraform uses the AWS CLI's default chain.
    let password = if host.use_cli_creds || matches!(host.provider, Provider::Azure | Provider::Gcp | Provider::Oci) { String::new() } else { get_secret(id)? };
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
    store.default.filter(|id| {
        store.hosts.iter().any(|h| {
            &h.id == id && !matches!(h.provider, Provider::Aws | Provider::Azure | Provider::Gcp | Provider::DigitalOcean | Provider::Linode | Provider::Oci)
        })
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(provider: Provider) -> HostProfile {
        HostProfile {
            gcp_project: None,
            id: "ab12".into(),
            name: "Lab".into(),
            provider,
            host: "10.0.0.5".into(),
            port: 8006,
            username: "root".into(),
            datastore: None,
            network: None,
            node: None,
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
    fn host_for_url_brackets_ipv6_only() {
        assert_eq!(host_for_url("10.0.0.5"), "10.0.0.5");
        assert_eq!(host_for_url("pve.lan"), "pve.lan");
        assert_eq!(host_for_url("fd00::5"), "[fd00::5]");
    }

    #[test]
    fn aws_terraform_env_uses_keys_or_cli_profile() {
        let mut h = profile(Provider::Aws);
        h.host = "eu-west-3".into();
        h.username = "AKIA...".into();
        let env = terraform_env(&h, "secret");
        assert_eq!(get(&env, "AWS_ACCESS_KEY_ID"), Some("AKIA..."));
        assert_eq!(get(&env, "AWS_SECRET_ACCESS_KEY"), Some("secret"));
        assert_eq!(get(&env, "AWS_REGION"), Some("eu-west-3"));
        // CLI-credential mode passes only the region and profile, never keys.
        h.use_cli_creds = true;
        h.aws_profile = Some("work".into());
        let env = terraform_env(&h, "secret");
        assert!(get(&env, "AWS_ACCESS_KEY_ID").is_none());
        assert_eq!(get(&env, "AWS_REGION"), Some("eu-west-3"));
        assert_eq!(get(&env, "AWS_PROFILE"), Some("work"));
    }

    #[test]
    fn token_cloud_terraform_env_passes_the_token() {
        let mut h = profile(Provider::DigitalOcean);
        assert_eq!(get(&terraform_env(&h, "dop_v1_abc"), "DIGITALOCEAN_TOKEN"), Some("dop_v1_abc"));
        h.provider = Provider::Linode;
        assert_eq!(get(&terraform_env(&h, "lin_tok"), "LINODE_TOKEN"), Some("lin_tok"));
        // Azure's env only carries the subscription id; GCP carries nothing (ADC).
        h.provider = Provider::Azure;
        h.username = "sub-id".into();
        assert_eq!(get(&terraform_env(&h, ""), "ARM_SUBSCRIPTION_ID"), Some("sub-id"));
        h.provider = Provider::Gcp;
        assert!(terraform_env(&h, "").is_empty());
    }

    #[test]
    fn cloud_terraform_vars_carry_region_and_auto_stop_minutes() {
        let mut h = profile(Provider::Aws);
        h.host = "eu-west-3".into();
        h.auto_stop_hours = Some(3);
        h.datastore = Some("t3.small".into());
        let vars = terraform_vars(&h, "sec");
        assert_eq!(get(&vars, "region"), Some("eu-west-3"));
        assert_eq!(get(&vars, "auto_stop_hours"), Some("3"));
        assert_eq!(get(&vars, "auto_stop_minutes"), Some("180"));
        // AWS size var is instance_type.
        assert_eq!(get(&vars, "instance_type"), Some("t3.small"));
        // No auto_stop_hours set falls back to the default.
        h.auto_stop_hours = None;
        let vars = terraform_vars(&h, "sec");
        assert_eq!(get(&vars, "auto_stop_hours"), Some(DEFAULT_AUTO_STOP_HOURS.to_string().as_str()));
    }

    #[test]
    fn cloud_size_var_name_differs_per_provider() {
        let size = |p: Provider, var: &str| {
            let mut h = profile(p);
            h.datastore = Some("sz".into());
            h.host = match p {
                Provider::Azure => "westeurope".into(),
                Provider::Gcp => "europe-west1".into(),
                Provider::DigitalOcean => "fra1".into(),
                Provider::Linode => "eu-central".into(),
                _ => "eu-west-3".into(),
            };
            assert_eq!(get(&terraform_vars(&h, ""), var), Some("sz"), "{p:?}");
        };
        size(Provider::Azure, "size");
        size(Provider::DigitalOcean, "size");
        size(Provider::Gcp, "machine_type");
        size(Provider::Linode, "type");
        size(Provider::Aws, "instance_type");
    }

    #[test]
    fn gcp_vars_prefer_existing_project_else_billing_account() {
        let mut h = profile(Provider::Gcp);
        h.host = "europe-west1".into();
        h.username = "0X0X0X-0X0X0X-0X0X0X".into();
        h.node = Some("123456789012".into());
        // No project yet: pass billing account and org.
        let vars = terraform_vars(&h, "");
        assert_eq!(get(&vars, "billing_account"), Some("0X0X0X-0X0X0X-0X0X0X"));
        assert_eq!(get(&vars, "org_id"), Some("123456789012"));
        assert!(get(&vars, "project").is_none());
        // An established project is reused instead.
        h.gcp_project = Some("cyberctf-labs-xyz".into());
        let vars = terraform_vars(&h, "");
        assert_eq!(get(&vars, "project"), Some("cyberctf-labs-xyz"));
        assert!(get(&vars, "billing_account").is_none());
    }

    #[test]
    fn oci_vars_carry_the_compartment() {
        let mut h = profile(Provider::Oci);
        h.host = "eu-frankfurt-1".into();
        h.username = "ocid1.compartment.oc1..aaaa".into();
        assert_eq!(get(&terraform_vars(&h, ""), "compartment_id"), Some("ocid1.compartment.oc1..aaaa"));
    }

    #[test]
    fn proxmox_password_vars_build_the_endpoint_and_connection() {
        let mut h = profile(Provider::Proxmox);
        h.username = "root@pam".into();
        h.node = Some("pve".into());
        let vars = terraform_vars(&h, "pw");
        assert_eq!(get(&vars, "proxmox_endpoint"), Some("https://10.0.0.5:8006/"));
        assert_eq!(get(&vars, "proxmox_username"), Some("root@pam"));
        assert_eq!(get(&vars, "proxmox_password"), Some("pw"));
        assert_eq!(get(&vars, "node"), Some("pve"));
        // A password setup carries no api token var.
        assert!(get(&vars, "proxmox_api_token").is_none());
    }

    #[test]
    fn proxmox_token_vars_use_api_token_and_ssh_user() {
        let mut h = profile(Provider::Proxmox);
        h.username = "root@pam!cyberctf".into();
        let vars = terraform_vars(&h, "sec");
        assert_eq!(get(&vars, "proxmox_username"), Some("root@pam"));
        assert_eq!(get(&vars, "proxmox_api_token"), Some("root@pam!cyberctf=sec"));
        assert_eq!(get(&vars, "proxmox_ssh_username"), Some("root"));
        assert!(get(&vars, "proxmox_password").is_none());
    }
}
