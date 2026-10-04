//! Talking to a Proxmox VE host's API for the Server screen: sign in (API token or
//! user + password), then check what a lab launch will need, so problems show up in
//! "Test connection" with their fix instead of halfway through a launch.
//!
//! A token is recognised by its id, `user@realm!name` (the username field holds it and
//! the keychain holds its secret). The cloud-init snippet still goes over SSH, which a
//! token can't do: token setups SSH as the token's user with the launcher's key.

use std::time::Duration;

use serde_json::Value;

use super::server::HostProfile;
use super::ssh;

const TIMEOUT: Duration = Duration::from_secs(8);

/// The storage `deploy/terraform/proxmox` puts the Debian image and the cloud-init
/// snippet on (its defaults, not configurable from the launcher).
pub const IMAGE_STORAGE: &str = "local";
pub const SNIPPET_STORAGE: &str = "local";

/// `user@realm!name`: a Proxmox API token id rather than a user.
pub fn is_token(username: &str) -> bool {
    username.split_once('!').is_some_and(|(user, name)| user.contains('@') && !name.is_empty())
}

/// The user a token belongs to (`root@pam!cyberctf` -> `root@pam`).
pub fn token_user(username: &str) -> &str {
    username.split_once('!').map(|(u, _)| u).unwrap_or(username)
}

/// The `api_token` value the Terraform provider takes.
pub fn terraform_token(username: &str, secret: &str) -> String {
    format!("{username}={secret}")
}

fn endpoint(h: &HostProfile) -> String {
    let host = if h.host.contains(':') { format!("[{}]", h.host) } else { h.host.clone() };
    format!("https://{host}:{}/api2/json", h.port)
}

/// A signed-in API client.
pub struct Session {
    client: reqwest::Client,
    base: String,
    /// The header that authenticates each call: a ticket cookie or the token.
    auth: (&'static str, String),
}

#[derive(Debug)]
pub enum SignInError {
    /// The host answered and refused the credentials.
    Rejected,
    /// Couldn't talk to the API (TLS, network, unexpected answer).
    Failed(String),
}

pub async fn sign_in(h: &HostProfile, secret: &str) -> Result<Session, SignInError> {
    let client =
        reqwest::Client::builder().timeout(TIMEOUT).tls_danger_accept_invalid_certs(h.insecure_tls).build().map_err(|e| SignInError::Failed(e.to_string()))?;
    let base = endpoint(h);
    if is_token(&h.username) {
        let session = Session { client, base, auth: ("Authorization", format!("PVEAPIToken={}={secret}", h.username)) };
        // Any authenticated call proves the token.
        return match session.call("/version").await {
            Ok(_) => Ok(session),
            Err(CallError::Status(401)) => Err(SignInError::Rejected),
            Err(e) => Err(SignInError::Failed(e.to_string())),
        };
    }
    let res = client
        .post(format!("{base}/access/ticket"))
        .form(&[("username", h.username.as_str()), ("password", secret)])
        .send()
        .await
        .map_err(|e| SignInError::Failed(describe(&e)))?;
    if res.status().as_u16() == 401 {
        return Err(SignInError::Rejected);
    }
    if !res.status().is_success() {
        return Err(SignInError::Failed(format!("the Proxmox API answered HTTP {}", res.status())));
    }
    let body: Value = res.json().await.map_err(|e| SignInError::Failed(e.to_string()))?;
    let ticket = body["data"]["ticket"].as_str().ok_or_else(|| SignInError::Failed("no ticket in the sign-in answer".into()))?;
    Ok(Session { client, base, auth: ("Cookie", format!("PVEAuthCookie={ticket}")) })
}

/// Turns a reqwest error into one readable line, calling out the usual self-signed case.
pub fn describe(e: &reqwest::Error) -> String {
    let detail = std::iter::successors(Some(e as &dyn std::error::Error), |e| e.source()).map(|e| e.to_string()).collect::<Vec<_>>().join(": ");
    if detail.to_lowercase().contains("certificate") {
        "the host's TLS certificate isn't trusted. Proxmox uses a self-signed certificate by default: turn on \"Self-signed certificate\" for this host, or install a trusted one".into()
    } else {
        detail
    }
}

#[derive(Debug)]
pub enum CallError {
    Status(u16),
    Other(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Status(code) => write!(f, "HTTP {code}"),
            CallError::Other(e) => f.write_str(e),
        }
    }
}

impl Session {
    /// GET `path` (under /api2/json) and return its `data`.
    pub async fn call(&self, path: &str) -> Result<Value, CallError> {
        let res = self.client.get(format!("{}{path}", self.base)).header(self.auth.0, &self.auth.1).send().await.map_err(|e| CallError::Other(describe(&e)))?;
        if !res.status().is_success() {
            return Err(CallError::Status(res.status().as_u16()));
        }
        let body: Value = res.json().await.map_err(|e| CallError::Other(e.to_string()))?;
        Ok(body["data"].clone())
    }

    /// The configured node, or the first one when none is set.
    pub async fn node(&self, h: &HostProfile) -> Result<String, CallError> {
        let nodes = self.call("/nodes").await?;
        let names: Vec<&str> = nodes.as_array().into_iter().flatten().filter_map(|n| n["node"].as_str()).collect();
        match h.node.as_deref().filter(|n| !n.is_empty()) {
            Some(n) if names.contains(&n) => Ok(n.to_string()),
            Some(n) => Err(CallError::Other(format!("there is no node \"{n}\" on this host (found: {})", names.join(", ")))),
            None => names.first().map(|n| n.to_string()).ok_or_else(|| CallError::Other("this user can't see any node".into())),
        }
    }
}

/// The outcome of "Test connection" for a Proxmox host.
pub struct Report {
    pub ok: bool,
    pub authenticated: Option<bool>,
    pub message: String,
}

fn fail(authenticated: Option<bool>, message: impl Into<String>) -> Report {
    Report { ok: false, authenticated, message: message.into() }
}

/// What a storage accepts, from `/nodes/<node>/storage` (`content` is comma-separated).
fn storage_content(storages: &Value, id: &str) -> Option<Vec<String>> {
    storages
        .as_array()?
        .iter()
        .find(|s| s["storage"].as_str() == Some(id))
        .map(|s| s["content"].as_str().unwrap_or_default().split(',').map(|c| c.trim().to_string()).collect())
}

const STORAGE_HINT: &str = "In the Proxmox web UI: Datacenter > Storage > select it > Edit > Content";

/// Missing storage content a lab launch needs, as fix-it sentences.
fn storage_problems(storages: &Value, vm_storage: &str) -> Vec<String> {
    let mut needs: Vec<(&str, &str, &str)> =
        vec![(IMAGE_STORAGE, "iso", "ISO image"), (SNIPPET_STORAGE, "snippets", "Snippets"), (vm_storage, "images", "Disk image")];
    needs.dedup();
    let mut problems = Vec::new();
    for (id, content, label) in needs {
        match storage_content(storages, id) {
            None => problems.push(format!("Storage \"{id}\" doesn't exist on this node, or this user can't see it.")),
            Some(c) if !c.iter().any(|x| x == content) => problems.push(format!("Storage \"{id}\" doesn't accept {label}s. {STORAGE_HINT}, add '{label}'.")),
            Some(_) => {}
        }
    }
    problems
}

/// Signs in, then checks the node, the storages and bridge a launch uses and, for token
/// setups, that the launcher's SSH key is authorized on the node.
pub async fn test(h: &HostProfile, secret: &str) -> Report {
    let session = match sign_in(h, secret).await {
        Ok(s) => s,
        Err(SignInError::Rejected) if is_token(&h.username) => {
            return fail(Some(false), "Proxmox rejected the API token. Check the token id (user@realm!name) and its secret.");
        }
        Err(SignInError::Rejected) => return fail(Some(false), "Proxmox rejected the credentials. Use user@realm, e.g. root@pam."),
        Err(SignInError::Failed(e)) => return fail(None, format!("Reachable, but the API call failed: {e}")),
    };
    let node = match session.node(h).await {
        Ok(n) => n,
        Err(CallError::Status(403)) => {
            return fail(
                Some(true),
                "Signed in, but this user or token can't list nodes. Give it the Administrator role, or create the token with privilege separation off.",
            );
        }
        Err(e) => return fail(Some(true), format!("Signed in, but listing nodes failed: {e}")),
    };

    let mut problems = Vec::new();
    let vm_storage = h.datastore.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "local-lvm".into());
    match session.call(&format!("/nodes/{node}/storage")).await {
        Ok(storages) => problems.extend(storage_problems(&storages, &vm_storage)),
        Err(e) => problems.push(format!("Couldn't list the node's storage ({e}).")),
    }
    let bridge = h.network.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "vmbr0".into());
    match session.call(&format!("/nodes/{node}/network")).await {
        Ok(ifaces) => {
            let found = ifaces.as_array().into_iter().flatten().any(|i| i["iface"].as_str() == Some(bridge.as_str()));
            if !found {
                problems.push(format!("Bridge \"{bridge}\" doesn't exist on {node}. Use one of the node's bridges (System > Network), e.g. vmbr0."));
            }
        }
        Err(e) => problems.push(format!("Couldn't list the node's network ({e}).")),
    }
    if is_token(&h.username)
        && let Some(problem) = ssh_key_problem(h).await
    {
        problems.push(problem);
    }

    if problems.is_empty() {
        Report {
            ok: true,
            authenticated: Some(true),
            message: format!("Signed in to the Proxmox API; node {node}, storage and bridge {bridge} are ready for labs."),
        }
    } else {
        fail(Some(true), format!("Signed in, but a lab launch would fail:\n• {}", problems.join("\n• ")))
    }
}

/// The SSH user for the snippet upload: the token's user without its realm.
pub fn ssh_user(username: &str) -> &str {
    token_user(username).split('@').next().unwrap_or("root")
}

/// Token setups upload the snippet over SSH with the launcher's key: checks it's authorized.
async fn ssh_key_problem(h: &HostProfile) -> Option<String> {
    let Some(identity) = ssh::launcher_key() else {
        return Some("The launcher's SSH key isn't ready yet; test again.".into());
    };
    let public = std::fs::read_to_string(identity.with_extension("pub")).unwrap_or_default().trim().to_string();
    let user = ssh_user(&h.username).to_string();
    let target = ssh::Target { host: h.host.clone(), port: 22, user: user.clone(), identity: identity.clone() };
    match target.exec(&identity.with_file_name("known_hosts"), "true").await {
        Ok(_) => None,
        Err(_) => Some(format!(
            "The launcher can't SSH to {user}@{} with its key, which a token setup needs to upload the lab's cloud-init. On the node, run:\n  echo '{public}' >> ~/.ssh/authorized_keys",
            h.host
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognises_token_ids() {
        assert!(is_token("root@pam!cyberctf"));
        assert!(!is_token("root@pam"));
        assert!(!is_token("root!x"));
        assert!(!is_token("root@pam!"));
        assert_eq!(token_user("root@pam!cyberctf"), "root@pam");
        assert_eq!(ssh_user("root@pam!cyberctf"), "root");
        assert_eq!(ssh_user("admin@pve"), "admin");
        assert_eq!(terraform_token("root@pam!cyberctf", "abc"), "root@pam!cyberctf=abc");
    }

    #[test]
    fn storage_problems_name_the_fix() {
        let ok = json!([{"storage": "local", "content": "iso,vztmpl,snippets,backup"}, {"storage": "local-lvm", "content": "images,rootdir"}]);
        assert!(storage_problems(&ok, "local-lvm").is_empty());
        let stock = json!([{"storage": "local", "content": "iso,vztmpl,backup"}, {"storage": "local-lvm", "content": "images,rootdir"}]);
        let p = storage_problems(&stock, "local-lvm");
        assert_eq!(p.len(), 1);
        assert!(p[0].contains("Snippets"));
        let p = storage_problems(&stock, "fast-ssd");
        assert!(p.iter().any(|m| m.contains("\"fast-ssd\" doesn't exist")));
    }

    /// "Test connection" against a real host (opt-in):
    ///   CYBERCTF_TEST_PVE_HOST=... CYBERCTF_TEST_PVE_PASSWORD=... [CYBERCTF_TEST_PVE_TOKEN_ID=user@realm!name CYBERCTF_TEST_PVE_TOKEN_SECRET=...
    ///   CYBERCTF_TEST_SSH_KEY=<key authorized on the node>] cargo test proxmox_live_test -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn proxmox_live_test() {
        let var = |k: &str| std::env::var(k).ok();
        let host = var("CYBERCTF_TEST_PVE_HOST").expect("CYBERCTF_TEST_PVE_HOST");
        let profile = |username: &str, bridge: &str| HostProfile {
            id: "t".into(),
            name: "t".into(),
            provider: crate::runtime::providers::Provider::Proxmox,
            host: host.clone(),
            port: 8006,
            username: username.into(),
            datastore: Some(var("CYBERCTF_TEST_PVE_STORAGE").unwrap_or_else(|| "local-lvm".into())),
            network: Some(bridge.into()),
            node: Some("pve".into()),
            insecure_tls: true,
            auto_stop_hours: None,
            use_cli_creds: false,
            aws_profile: None,
            monthly_limit: None,
        };
        let bridge = var("CYBERCTF_TEST_PVE_BRIDGE").unwrap_or_else(|| "vmbr1".into());
        let password = var("CYBERCTF_TEST_PVE_PASSWORD").expect("CYBERCTF_TEST_PVE_PASSWORD");

        let r = test(&profile("root@pam", &bridge), &password).await;
        println!("password: ok={} {}", r.ok, r.message);
        assert!(r.ok);
        let r = test(&profile("root@pam", &bridge), "wrong").await;
        println!("bad password: {}", r.message);
        assert_eq!(r.authenticated, Some(false));
        let r = test(&profile("root@pam", "vmbr-nope"), &password).await;
        println!("bad bridge: {}", r.message);
        assert!(!r.ok && r.message.contains("vmbr-nope"));

        if let (Some(secret), Some(key)) = (var("CYBERCTF_TEST_PVE_TOKEN_SECRET"), var("CYBERCTF_TEST_SSH_KEY")) {
            ssh::set_launcher_key_for_test(key.into());
            let token = var("CYBERCTF_TEST_PVE_TOKEN_ID").unwrap_or_else(|| "root@pam!cyberctf-live".into());
            let r = test(&profile(&token, &bridge), &secret).await;
            println!("token: ok={} {}", r.ok, r.message);
            assert!(r.ok);
            let r = test(&profile(&token, &bridge), "00000000-0000-0000-0000-000000000000").await;
            println!("bad token: {}", r.message);
            assert_eq!(r.authenticated, Some(false));
        }
    }
}
