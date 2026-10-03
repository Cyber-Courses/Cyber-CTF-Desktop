//! Reaching a remote lab host over SSH, for "Open shell" on labs that run on a server
//! host or in the cloud: the attack box runs next to the lab there, so the shell is
//! `ssh <lab host> sudo docker exec -it attacker bash`.
//!
//! The launcher has its own key (`<app data>/ssh/id_ed25519`), made once with the
//! system's `ssh-keygen` and installed on lab hosts by cloud-init (`ssh_public_key`).
//! Vagrant targets (ESXi) use Vagrant's own key, read from `vagrant ssh-config`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::exec::run;

fn ssh_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("ssh");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The launcher's private key, created on first use. Returns (key path, public key line).
pub async fn ensure_key(app: &AppHandle) -> Result<(PathBuf, String)> {
    let key = ssh_dir(app)?.join("id_ed25519");
    if !key.is_file() {
        let path = key.to_string_lossy().to_string();
        run("ssh-keygen", &["-q", "-t", "ed25519", "-N", "", "-C", "cyberctf-launcher", "-f", &path], None).await?;
    }
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
    Some(Target { host: host?, port, user: user?, identity: identity? })
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
    /// The shell command that opens the remote attack box. `known_hosts` keeps the
    /// launcher's host keys away from the player's own ~/.ssh.
    pub fn attack_shell_command(&self, known_hosts: &Path) -> Result<String> {
        if !safe_token(&self.host) || !safe_token(&self.user) {
            return Err(Error::Invalid("unexpected SSH host or user".into()));
        }
        Ok(format!(
            "ssh -t -i {} -p {} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={} -o LogLevel=ERROR {}@{} sudo docker exec -it attacker bash",
            sh_quote(&self.identity.to_string_lossy()),
            self.port,
            sh_quote(&known_hosts.to_string_lossy()),
            self.user,
            self.host,
        ))
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
        let t = Target { host: "10.0.0.5".into(), port: 22, user: "debian".into(), identity: "/Users/a b/key".into() };
        let cmd = t.attack_shell_command(Path::new("/x/known_hosts")).unwrap();
        assert!(cmd.contains("-i '/Users/a b/key'"));
        assert!(cmd.ends_with("debian@10.0.0.5 sudo docker exec -it attacker bash"));
        let bad = Target { host: "10.0.0.5;rm".into(), ..t };
        assert!(bad.attack_shell_command(Path::new("/x")).is_err());
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }
}
