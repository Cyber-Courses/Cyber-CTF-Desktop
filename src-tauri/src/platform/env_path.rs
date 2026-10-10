//! A GUI app on macOS (and some Linux desktops) starts with a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell PATH. The tools labs need
//! (docker and its credential helper, vagrant, ovftool) live elsewhere, so append the
//! standard install locations once at startup. Existing entries keep priority.

use std::path::PathBuf;

/// Dirs added even before they exist: a tool installed there while the app runs (the gcloud
/// SDK, per user, from the Cloud setup) is then found without a restart, since PATH is only
/// set once at startup.
fn future_dirs() -> Vec<PathBuf> {
    let gcloud_sdk = if cfg!(target_os = "linux") { super::home_dir().map(|home| home.join("google-cloud-sdk/bin")) } else { None };
    gcloud_sdk.into_iter().collect()
}

/// Where the tools live when they are installed, on this OS.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(unix)]
    {
        dirs.extend(["/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin"].map(PathBuf::from));
        if let Some(home) = super::home_dir() {
            // Docker Desktop's per-user CLI install, and user-level installs.
            dirs.push(home.join(".docker/bin"));
            dirs.push(home.join(".local/bin"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push("/Applications/Docker.app/Contents/Resources/bin".into());
        // ovftool, which vagrant-vmware-esxi needs, ships inside VMware Fusion.
        dirs.push("/Applications/VMware Fusion.app/Contents/Library/VMware OVF Tool".into());
        dirs.push("/Applications/VMware Fusion.app/Contents/Library".into());
    }
    #[cfg(windows)]
    {
        if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            dirs.push(pf.join("VMware").join("VMware OVF Tool"));
            dirs.push(pf.join("Vagrant").join("bin"));
        }
    }
    dirs
}

/// `current` with every existing extra dir appended (no duplicates).
fn augmented(current: Option<std::ffi::OsString>) -> Option<std::ffi::OsString> {
    let mut paths: Vec<PathBuf> = current.as_deref().map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    let before = paths.len();
    for dir in extra_dirs() {
        if dir.is_dir() && !paths.contains(&dir) {
            paths.push(dir);
        }
    }
    for dir in future_dirs() {
        if !paths.contains(&dir) {
            paths.push(dir);
        }
    }
    if paths.len() == before {
        return None;
    }
    std::env::join_paths(paths).ok()
}

/// Call first thing in `run()`, before any thread is spawned.
pub fn augment() {
    if let Some(path) = augmented(std::env::var_os("PATH")) {
        // SAFETY: called at the very start of `run()`, while the process is still
        // single-threaded (before Tauri, tokio or any plugin starts a thread).
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On this machine, with the PATH a Finder-launched app gets, the tools labs need are
    /// found after `augment()` (opt-in: it changes the process PATH; run single-threaded):
    ///   cargo test --lib finder_path_finds_tools -- --ignored --test-threads=1
    #[test]
    #[ignore]
    fn finder_path_finds_tools() {
        // SAFETY: opt-in test, run with --test-threads=1.
        unsafe { std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin") };
        let found = |tool: &str| std::process::Command::new(tool).arg("--version").output().is_ok();
        assert!(!found("docker"), "docker should be missing on the bare Finder PATH");
        augment();
        for tool in ["docker", "vagrant"] {
            assert!(found(tool), "{tool} not found after augment(); PATH={:?}", std::env::var("PATH"));
        }
        let compose = std::process::Command::new("docker").args(["compose", "version", "--short"]).output().unwrap();
        assert!(compose.status.success(), "docker compose plugin not found");
    }

    #[test]
    fn appends_existing_dirs_once_and_keeps_order() {
        let tmp = std::env::temp_dir();
        let current = std::env::join_paths([PathBuf::from("/usr/bin"), tmp.clone()]).unwrap();
        let out = augmented(Some(current)).unwrap_or_default();
        let paths: Vec<PathBuf> = std::env::split_paths(&out).collect();
        if !paths.is_empty() {
            assert_eq!(paths[0], PathBuf::from("/usr/bin"));
            assert_eq!(paths.iter().filter(|p| p.as_path() == std::path::Path::new("/usr/bin")).count(), 1);
        }
    }
}
