//! Which Docker-compatible engines this machine has, which one the CLI uses, and switching or
//! starting one the way the player would.

use std::time::Duration;

use crate::error::{Error, Result};
use crate::exec::{docker_denied, docker_denied_message, run, run_read};

/// How long each engine's context may take to answer before it counts as stopped.
const ENGINE_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// How long a started engine is waited for: 90 tries, 2 s apart.
const START_TRIES: u32 = 90;
const START_POLL: Duration = Duration::from_secs(2);

/// `docker info`'s operating system line: the daemon answers (for this account).
pub(super) async fn daemon_os() -> Result<String> {
    run_read("docker", &["info", "--format", "{{.OperatingSystem}}"], None).await
}

/// Name the running engine from the daemon's OS string and the active CLI context.
pub(super) async fn engine_in_use(os: &str) -> &'static str {
    let context = run_read("docker", &["context", "show"], None).await.unwrap_or_default();
    engine_named(os, &context)
}

/// The engine a daemon's OS string and the CLI's current context point to.
fn engine_named(os: &str, context: &str) -> &'static str {
    let (os, context) = (os.to_lowercase(), context.to_lowercase());
    if os.contains("orbstack") || context.contains("orbstack") {
        "orbstack"
    } else if context.contains("colima") {
        "colima"
    } else if os.contains("rancher") || context.contains("rancher") {
        "rancher-desktop"
    } else if os.contains("podman") || context.contains("podman") {
        "podman"
    } else if os.contains("docker desktop") || context.starts_with("desktop-") {
        "docker-desktop"
    } else {
        "docker-engine"
    }
}

/// The engine behind a Docker CLI context, by the names the engines give their contexts.
/// `default` only counts on Linux, where it is the native daemon; elsewhere its socket is a
/// link to whichever desktop app installed it, so it says nothing on its own.
fn context_engine(name: &str, os: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n == "orbstack" {
        Some("orbstack")
    } else if n.starts_with("desktop-") {
        Some("docker-desktop")
    } else if n == "colima" || n.starts_with("colima-") {
        Some("colima")
    } else if n == "rancher-desktop" {
        Some("rancher-desktop")
    } else if n.starts_with("podman") {
        Some("podman")
    } else if n == "default" && os == "linux" {
        Some("docker-engine")
    } else {
        None
    }
}

/// The Docker CLI contexts, each with the engine behind it (unknown contexts are left out).
async fn engine_contexts() -> Vec<(String, &'static str)> {
    let out = run_read("docker", &["context", "ls", "--format", "{{.Name}}"], None).await.unwrap_or_default();
    contexts_from(&out, std::env::consts::OS)
}

/// `docker context ls` names (the current one marked ` *`), each with its engine.
fn contexts_from(listing: &str, os: &str) -> Vec<(String, &'static str)> {
    listing.lines().map(|l| l.trim().trim_end_matches(" *").to_string()).filter_map(|name| context_engine(&name, os).map(|e| (name, e))).collect()
}

/// Engines whose context answers, probed one by one (a stopped engine fails fast; the
/// timeout covers one that hangs).
pub(super) async fn running_engines() -> Vec<&'static str> {
    let mut running = Vec::new();
    for (name, engine) in engine_contexts().await {
        let args = ["--context", name.as_str(), "version", "--format", "{{.Server.Version}}"];
        let probe = run("docker", &args, None);
        if matches!(tokio::time::timeout(ENGINE_PROBE_TIMEOUT, probe).await, Ok(Ok(_))) && !running.contains(&engine) {
            running.push(engine);
        }
    }
    running
}

/// Points the Docker CLI at another running engine (`docker context use`), as the player
/// would in a terminal. Labs then run on it.
#[tauri::command]
pub async fn docker_use_engine(engine: String) -> Result<()> {
    let name = engine_contexts()
        .await
        .into_iter()
        .find(|(_, e)| *e == engine)
        .map(|(name, _)| name)
        .ok_or_else(|| Error::Invalid(format!("no Docker context for {engine}")))?;
    run("docker", &["context", "use", &name], None).await?;
    Ok(())
}

/// Starts an installed engine that isn't running, the way the player would (open the app or run
/// its CLI), points Docker at it and waits until it answers. Docker Desktop and OrbStack take a
/// while on first start, hence the generous wait.
#[tauri::command]
pub async fn docker_start_engine(engine: String) -> Result<()> {
    // Running already, but not for this account: starting it again can't help.
    if let Err(e) = daemon_os().await
        && docker_denied(&e)
    {
        return Err(Error::Invalid(docker_denied_message()));
    }
    launch(&engine).await?;
    for _ in 0..START_TRIES {
        // The engine's context appears once it is up; point Docker at it, then ask the daemon.
        let _ = docker_use_engine(engine.clone()).await;
        match daemon_os().await {
            Ok(_) => return Ok(()),
            // Up now, but not for this account: say so instead of waiting out the 3 minutes.
            Err(e) if docker_denied(&e) => return Err(Error::Invalid(docker_denied_message())),
            Err(_) => {}
        }
        tokio::time::sleep(START_POLL).await;
    }
    Err(Error::Invalid(format!("{engine} didn't answer within 3 minutes. Check its window, then re-check.")))
}

/// Opens the engine's app, or runs its CLI, on this OS.
async fn launch(engine: &str) -> Result<String> {
    match (std::env::consts::OS, engine) {
        ("macos", "docker-desktop") => run("open", &["-a", "Docker"], None).await,
        ("macos", "orbstack") => run("open", &["-a", "OrbStack"], None).await,
        ("windows", "docker-desktop") => run("cmd", &["/C", "start", "", r"C:\Program Files\Docker\Docker\Docker Desktop.exe"], None).await,
        ("linux", "docker-engine") => run("pkexec", &["systemctl", "start", "docker"], None).await.map_err(|e| match e {
            Error::ToolMissing { .. } => Error::Invalid(crate::platform::steps::NO_PKEXEC.into()),
            e => e,
        }),
        (_, "colima") => run("colima", &["start"], None).await,
        _ => Err(Error::Invalid(format!("Cyber CTF can't start {engine} here; start it yourself, then re-check."))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_engine_from_the_daemon_and_the_context() {
        assert_eq!(engine_named("OrbStack", "default"), "orbstack");
        assert_eq!(engine_named("Ubuntu 24.04", "colima"), "colima");
        assert_eq!(engine_named("Rancher Desktop WSL Distribution", "default"), "rancher-desktop");
        assert_eq!(engine_named("Docker Desktop", "default"), "docker-desktop");
        assert_eq!(engine_named("Debian", "desktop-linux"), "docker-desktop");
        assert_eq!(engine_named("Ubuntu 24.04 LTS", "default"), "docker-engine");
    }

    #[test]
    fn contexts_map_to_engines_and_default_only_counts_on_linux() {
        let listing = "default *\ndesktop-linux\norbstack\ncolima-dev\nmy-remote\n";
        assert_eq!(
            contexts_from(listing, "macos"),
            [("desktop-linux".to_string(), "docker-desktop"), ("orbstack".into(), "orbstack"), ("colima-dev".into(), "colima")]
        );
        assert_eq!(contexts_from("default *\n", "linux"), [("default".to_string(), "docker-engine")]);
        assert_eq!(context_engine("podman-machine-default", "macos"), Some("podman"));
        assert_eq!(context_engine("rancher-desktop", "windows"), Some("rancher-desktop"));
    }
}
