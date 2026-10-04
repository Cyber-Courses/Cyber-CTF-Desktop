//! Where server and cloud profiles are kept: server.json in app data, secrets in the OS
//! keychain (a dev-only JSON file in debug builds).

use super::*;

// --- storage --------------------------------------------------------------

pub(super) fn store_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(STORE_FILE))
}

pub(super) fn load(app: &AppHandle) -> Result<Store> {
    match std::fs::read_to_string(store_path(app)?) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| Error::Invalid(format!("server.json: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.into()),
    }
}

pub(super) fn save(app: &AppHandle, store: &Store) -> Result<()> {
    let raw = serde_json::to_string_pretty(store).map_err(|e| Error::Invalid(e.to_string()))?;
    std::fs::write(store_path(app)?, raw)?;
    Ok(())
}

pub(super) fn find(store: &Store, id: &str) -> Result<HostProfile> {
    store.hosts.iter().find(|h| h.id == id).cloned().ok_or_else(|| Error::Invalid(format!("server host `{id}` not found")))
}

// Secrets: keychain in release; a 0600 file in debug, since every `tauri dev` rebuild is
// a new unsigned binary and the keychain would re-prompt on each run (same as auth.rs).

#[cfg(not(debug_assertions))]
pub(super) fn secret_entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(crate::config::KEYCHAIN_SERVICE, &format!("server:{id}")).map_err(|e| Error::Invalid(format!("keychain: {e}")))
}

#[cfg(debug_assertions)]
pub(super) fn dev_secrets_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or_else(|| Error::Invalid("no home directory".into()))?;
    Ok(PathBuf::from(home).join(".cyberctf").join("dev-server-secrets.json"))
}

#[cfg(debug_assertions)]
pub(super) fn dev_secrets() -> std::collections::BTreeMap<String, String> {
    dev_secrets_path().ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default()
}

#[cfg(debug_assertions)]
pub(super) fn write_dev_secrets(map: &std::collections::BTreeMap<String, String>) -> Result<()> {
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

pub(super) fn get_secret(id: &str) -> Result<String> {
    #[cfg(debug_assertions)]
    let secret = dev_secrets().remove(id);
    #[cfg(not(debug_assertions))]
    let secret = secret_entry(id)?.get_password().ok();
    secret.ok_or_else(|| Error::Invalid("no password stored for this host, edit it and enter one".into()))
}

pub(super) fn set_secret(id: &str, secret: &str) -> Result<()> {
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

pub(super) fn delete_secret(id: &str) {
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
