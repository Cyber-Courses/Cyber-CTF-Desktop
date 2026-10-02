//! Assisted, one-click install of lab dependencies (Docker, Vagrant, VM providers).
//! Detection lives in `system`; this runs the platform package manager and streams its
//! output. It is not silent: the OS / package manager handles its own elevation prompt.
//!
//! Elevation per platform:
//!  - macOS: Homebrew. Docker is Colima + the docker CLI (userland, NO admin). Casks that
//!    need admin (Vagrant, VirtualBox) fail from a GUI app because brew's internal `sudo`
//!    has no terminal, so we first prime sudo through a GUI askpass dialog; brew then finds
//!    cached credentials.
//!  - Windows: winget (its own UAC prompt).
//!  - Linux: pkexec (a graphical polkit prompt).

use std::path::Path;
use std::process::Stdio;

use serde::Deserialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{Error, Result};

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Dependency {
    Docker,
    Vagrant,
    Virtualbox,
}

struct Step {
    program: String,
    args: Vec<String>,
    /// macOS only: prime GUI sudo before this step (brew casks that need admin).
    needs_admin: bool,
}

fn step(program: impl Into<String>, args: &[&str], needs_admin: bool) -> Step {
    Step { program: program.into(), args: args.iter().map(|s| s.to_string()).collect(), needs_admin }
}

#[cfg(target_os = "macos")]
fn brew_bin() -> Option<String> {
    // GUI apps don't inherit the shell PATH, so resolve brew's known locations.
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().find(|p| Path::new(p).exists()).map(String::from)
}

/// The ordered install steps for a dependency on this OS.
fn plan(dep: Dependency) -> Result<Vec<Step>> {
    #[cfg(target_os = "macos")]
    {
        let brew = brew_bin().ok_or_else(|| Error::Invalid("Homebrew is required. Install it from https://brew.sh, then try again.".into()))?;
        let bin_dir = Path::new(&brew).parent().map(Path::to_path_buf).unwrap_or_default();
        let colima = bin_dir.join("colima").to_string_lossy().into_owned();
        Ok(match dep {
            // Colima + docker CLI: a userland Docker engine, no admin, no Docker Desktop licence.
            Dependency::Docker => vec![
                step(brew, &["install", "colima", "docker", "docker-compose"], false),
                Step { program: colima, args: vec!["start".into()], needs_admin: false },
            ],
            Dependency::Vagrant => vec![step(brew, &["install", "--cask", "vagrant"], true)],
            Dependency::Virtualbox => vec![step(brew, &["install", "--cask", "virtualbox"], true)],
        })
    }
    #[cfg(target_os = "windows")]
    {
        let id = match dep {
            Dependency::Docker => "Docker.DockerDesktop",
            Dependency::Vagrant => "Hashicorp.Vagrant",
            Dependency::Virtualbox => "Oracle.VirtualBox",
        };
        Ok(vec![step("winget", &["install", "-e", "--id", id, "--accept-source-agreements", "--accept-package-agreements"], false)])
    }
    #[cfg(target_os = "linux")]
    {
        // pkexec raises a graphical password prompt (polkit) for the privileged install.
        Ok(match dep {
            Dependency::Docker => vec![step("pkexec", &["sh", "-c", "curl -fsSL https://get.docker.com | sh"], false)],
            Dependency::Vagrant => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y vagrant"], false)],
            Dependency::Virtualbox => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y virtualbox"], false)],
        })
    }
}

/// macOS: cache sudo credentials via a native GUI password dialog, so a later brew cask
/// (which calls `sudo` without a terminal) succeeds. `sudo -A -v` reads the password from
/// SUDO_ASKPASS and refreshes the timestamp for this session.
#[cfg(target_os = "macos")]
async fn prime_sudo(on_line: &mut impl FnMut(String)) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let script = std::env::temp_dir().join("cyberctf-askpass.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\nosascript -e 'display dialog \"Cyber CTF needs your macOS password to install this tool.\" default answer \"\" with hidden answer with title \"Cyber CTF\"' -e 'text returned of result'\n",
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    on_line("Requesting administrator access…".into());
    let status = Command::new("sudo")
        .args(["-A", "-v"])
        .env("SUDO_ASKPASS", &script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(Error::Io)?;
    let _ = std::fs::remove_file(&script);
    if !status.success() {
        return Err(Error::Invalid("Administrator access was not granted.".into()));
    }
    Ok(())
}

async fn run_step(step: &Step, on_line: &mut impl FnMut(String)) -> Result<()> {
    #[cfg(target_os = "macos")]
    if step.needs_admin {
        prime_sudo(on_line).await?;
    }
    let mut child = Command::new(&step.program)
        .args(&step.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::Invalid(format!("{} is not available on this machine.", step.program)),
            _ => Error::Io(e),
        })?;
    let mut out = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut err = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
    let (mut out_done, mut err_done) = (false, false);
    while !(out_done && err_done) {
        tokio::select! {
            l = out.next_line(), if !out_done => match l? { Some(x) => on_line(x), None => out_done = true },
            l = err.next_line(), if !err_done => match l? { Some(x) => on_line(x), None => err_done = true },
        }
    }
    let status = child.wait().await?;
    if !status.success() {
        return Err(Error::Invalid(format!("`{}` exited with {status}", step.program)));
    }
    Ok(())
}

/// Installs a dependency, streaming each command and its output to the UI.
#[tauri::command]
pub async fn install_dependency(dependency: Dependency, logs: Channel<String>) -> Result<()> {
    let mut on_line = move |line: String| {
        let _ = logs.send(line);
    };
    let steps = plan(dependency).inspect_err(|e| on_line(e.to_string()))?;
    for step in &steps {
        on_line(format!("$ {} {}", step.program, step.args.join(" ")));
        run_step(step, &mut on_line).await?;
    }
    on_line("Done. Re-checking this machine…".into());
    Ok(())
}

/// Installs a Vagrant plugin (userland, no admin), streaming the output. The plugin name
/// is validated so it can never be anything but a `vagrant-*` / `vagrant_*` identifier.
#[tauri::command]
pub async fn install_vagrant_plugin(plugin: String, logs: Channel<String>) -> Result<()> {
    let valid = (plugin.starts_with("vagrant-") || plugin.starts_with("vagrant_"))
        && plugin.len() <= 64
        && plugin.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(Error::Invalid(format!("invalid plugin name `{plugin}`")));
    }
    let mut on_line = move |line: String| {
        let _ = logs.send(line);
    };
    let step = Step { program: "vagrant".into(), args: vec!["plugin".into(), "install".into(), plugin], needs_admin: false };
    on_line(format!("$ {} {}", step.program, step.args.join(" ")));
    run_step(&step, &mut on_line).await?;
    on_line("Done. Re-checking this machine…".into());
    Ok(())
}
