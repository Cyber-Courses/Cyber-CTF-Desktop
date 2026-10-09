//! Reaching a remote lab host over SSH, for "Open shell" on labs that run on a server
//! host or in the cloud: the attack box runs next to the lab there, so the shell is
//! `ssh <lab host> sudo docker exec -it attacker bash`.
//!
//! The launcher has its own key (`<app data>/ssh/id_ed25519`), made once with the
//! system's `ssh-keygen` and installed on lab hosts by cloud-init (`ssh_public_key`).
//! Vagrant targets (ESXi) use Vagrant's own key, read from `vagrant ssh-config`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::exec::run;

fn ssh_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("ssh");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The launcher's key path once `ensure_key` has run, for code without an AppHandle
/// (the Terraform driver waiting on a lab host it just installed the key on).
static LAUNCHER_KEY: OnceLock<PathBuf> = OnceLock::new();

pub fn launcher_key() -> Option<PathBuf> {
    LAUNCHER_KEY.get().cloned()
}

#[cfg(test)]
pub fn set_launcher_key_for_test(key: PathBuf) {
    let _ = LAUNCHER_KEY.set(key);
}

/// The launcher's private key, created on first use. Returns (key path, public key line).
pub async fn ensure_key(app: &AppHandle) -> Result<(PathBuf, String)> {
    let key = ssh_dir(app)?.join("id_ed25519");
    if !key.is_file() {
        let path = key.to_string_lossy().to_string();
        run("ssh-keygen", &["-q", "-t", "ed25519", "-N", "", "-C", "cyberctf-launcher", "-f", &path], None).await?;
    }
    let _ = LAUNCHER_KEY.set(key.clone());
    let public = std::fs::read_to_string(key.with_extension("pub"))?.trim().to_string();
    Ok((key, public))
}

/// Where to SSH: what `ssh` needs, nothing more.
#[derive(Debug, PartialEq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity: PathBuf,
    /// `user@host` to go through (with the same key) when `host` isn't routable from here: a
    /// lab VM on a Proxmox node's host-internal bridge, reached via the node.
    pub jump: Option<String>,
}

/// Target from `vagrant ssh-config` output (HostName, Port, User, IdentityFile).
pub fn parse_ssh_config(out: &str) -> Option<Target> {
    let mut host = None;
    let mut port = 22;
    let mut user = None;
    let mut identity = None;
    for line in out.lines() {
        let mut parts = line.trim().splitn(2, char::is_whitespace);
        let (Some(key), Some(value)) = (parts.next(), parts.next()) else { continue };
        let value = value.trim().trim_matches('"');
        match key {
            "HostName" => host = Some(value.to_string()),
            "Port" => port = value.parse().unwrap_or(22),
            "User" => user = Some(value.to_string()),
            // The first IdentityFile is the machine's private key.
            "IdentityFile" if identity.is_none() => identity = Some(PathBuf::from(value)),
            _ => {}
        }
    }
    Some(Target { host: host?, port, user: user?, identity: identity?, jump: None })
}

/// A user or host we are willing to put on a command line.
fn safe_token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:".contains(c)) && !s.starts_with('-')
}

/// POSIX single-quoting.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

impl Target {
    /// `-o ProxyCommand=…` through the jump host, with the same key and known_hosts.
    fn proxy_option(&self, known_hosts: &Path) -> Result<Option<String>> {
        let Some(jump) = &self.jump else { return Ok(None) };
        let (user, host) = jump.split_once('@').ok_or_else(|| Error::Invalid("unexpected jump host".into()))?;
        if !safe_token(user) || !safe_token(host) {
            return Err(Error::Invalid("unexpected jump host".into()));
        }
        Ok(Some(format!(
            "ProxyCommand=ssh -i {} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={} -o LogLevel=ERROR -W %h:%p {jump}",
            sh_quote(&self.identity.to_string_lossy()),
            sh_quote(&known_hosts.to_string_lossy()),
        )))
    }

    /// The shell command that opens the remote attack box. `known_hosts` keeps the
    /// launcher's host keys away from the player's own ~/.ssh.
    pub fn attack_shell_command(&self, known_hosts: &Path) -> Result<String> {
        if !safe_token(&self.host) || !safe_token(&self.user) {
            return Err(Error::Invalid("unexpected SSH host or user".into()));
        }
        let proxy = self.proxy_option(known_hosts)?.map(|p| format!("-o {} ", sh_quote(&p))).unwrap_or_default();
        Ok(format!(
            "ssh -t -i {} -p {} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={} -o LogLevel=ERROR {proxy}{}@{} sudo docker exec -it attacker bash",
            sh_quote(&self.identity.to_string_lossy()),
            self.port,
            sh_quote(&known_hosts.to_string_lossy()),
            self.user,
            self.host,
        ))
    }
}

impl Target {
    /// Runs `command` on the lab host, non-interactively (no password prompt, short
    /// connect timeout). `known_hosts` should be per deployment: a new VM on a reused
    /// address has a new host key.
    pub async fn exec(&self, known_hosts: &Path, command: &str) -> Result<String> {
        if !safe_token(&self.host) || !safe_token(&self.user) {
            return Err(Error::Invalid("unexpected SSH host or user".into()));
        }
        let identity = self.identity.to_string_lossy().to_string();
        let port = self.port.to_string();
        let known = format!("UserKnownHostsFile={}", known_hosts.to_string_lossy());
        let dest = format!("{}@{}", self.user, self.host);
        let proxy = self.proxy_option(known_hosts)?;
        let mut args: Vec<&str> = vec![
            "-i",
            &identity,
            "-p",
            &port,
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            &known,
            "-o",
            "LogLevel=ERROR",
        ];
        if let Some(p) = &proxy {
            args.extend(["-o", p.as_str()]);
        }
        args.extend([dest.as_str(), command]);
        run("ssh", &args, None).await
    }
}

pub fn known_hosts(app: &AppHandle) -> Result<PathBuf> {
    Ok(ssh_dir(app)?.join("known_hosts"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vagrant_ssh_config() {
        let out = "Host labhost\n  HostName 192.168.1.50\n  User vagrant\n  Port 22\n  UserKnownHostsFile /dev/null\n  IdentityFile \"/Users/a b/lab/.vagrant/machines/labhost/vmware_esxi/private_key\"\n  IdentitiesOnly yes\n";
        let t = parse_ssh_config(out).unwrap();
        assert_eq!(t.host, "192.168.1.50");
        assert_eq!(t.user, "vagrant");
        assert_eq!(t.identity, PathBuf::from("/Users/a b/lab/.vagrant/machines/labhost/vmware_esxi/private_key"));
    }

    #[test]
    fn command_quotes_paths_and_rejects_odd_hosts() {
        let t = Target { host: "10.0.0.5".into(), port: 22, user: "debian".into(), identity: "/Users/a b/key".into(), jump: None };
        let cmd = t.attack_shell_command(Path::new("/x/known_hosts")).unwrap();
        assert!(cmd.contains("-i '/Users/a b/key'"));
        assert!(cmd.ends_with("debian@10.0.0.5 sudo docker exec -it attacker bash"));
        let bad = Target { host: "10.0.0.5;rm".into(), ..t };
        assert!(bad.attack_shell_command(Path::new("/x")).is_err());
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }
}
