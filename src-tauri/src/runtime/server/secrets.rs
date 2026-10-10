//! Each host's secret (password, API token or access key): the OS keychain in release builds,
//! a 0600 JSON file in debug builds, since every `tauri dev` rebuild is a new unsigned binary
//! and the keychain would re-prompt on each run (same as auth.rs).

use super::profile::HostProfile;
use crate::error::{Error, Result};

#[cfg(not(debug_assertions))]
fn entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(crate::config::KEYCHAIN_SERVICE, &format!("server:{id}")).map_err(|e| Error::Invalid(format!("keychain: {e}")))
}

#[cfg(debug_assertions)]
mod dev_file {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use crate::error::{Error, Result};

    fn path() -> Result<PathBuf> {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or_else(|| Error::Invalid("no home directory".into()))?;
        Ok(PathBuf::from(home).join(".cyberctf").join("dev-server-secrets.json"))
    }

    pub fn read() -> BTreeMap<String, String> {
        path().ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default()
    }

    pub fn write(map: &BTreeMap<String, String>) -> Result<()> {
        let path = path()?;
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
}

pub(super) fn get_secret(id: &str) -> Result<String> {
    #[cfg(debug_assertions)]
    let secret = dev_file::read().remove(id);
    #[cfg(not(debug_assertions))]
    let secret = entry(id)?.get_password().ok();
    secret.ok_or_else(|| Error::Invalid("no password stored for this host, edit it and enter one".into()))
}

pub(super) fn set_secret(id: &str, secret: &str) -> Result<()> {
    #[cfg(debug_assertions)]
    {
        let mut map = dev_file::read();
        map.insert(id.to_string(), secret.to_string());
        dev_file::write(&map)
    }
    #[cfg(not(debug_assertions))]
    {
        entry(id)?.set_password(secret).map_err(|e| Error::Invalid(format!("keychain: {e}")))
    }
}

pub(super) fn delete_secret(id: &str) {
    #[cfg(debug_assertions)]
    {
        let mut map = dev_file::read();
        if map.remove(id).is_some() {
            let _ = dev_file::write(&map);
        }
    }
    #[cfg(not(debug_assertions))]
    {
        if let Ok(e) = entry(id) {
            let _ = e.delete_credential();
        }
    }
}

/// The secret a host connects with: empty for hosts that sign in through their own CLI (see
/// `HostProfile::keeps_secret`), else the stored one.
pub(super) fn host_secret(host: &HostProfile) -> Result<String> {
    if host.keeps_secret() { get_secret(&host.id) } else { Ok(String::new()) }
}
