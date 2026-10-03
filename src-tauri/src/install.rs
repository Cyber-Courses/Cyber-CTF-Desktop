//! Assisted, one-click install of lab dependencies, streaming the package manager's output.
//! It never shows a custom password prompt: it uses the OS's own trusted flow (winget's
//! UAC, Linux pkexec, or downloading the official app/installer for macOS casks and
//! letting the tool's own installer run).

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
    Qemu,
    Utm,
    Libvirt,
    Awscli,
    Azurecli,
    Gcloud,
}

struct Step {
    program: String,
    args: Vec<String>,
    /// A note shown before the step (e.g. when we open a download instead of installing).
    note: Option<String>,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn step(program: impl Into<String>, args: &[&str]) -> Step {
    Step { program: program.into(), args: args.iter().map(|s| s.to_string()).collect(), note: None }
}

#[cfg(target_os = "macos")]
fn brew_bin() -> Option<String> {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().find(|p| Path::new(p).exists()).map(String::from)
}

// Download the installer with brew (no admin needed), then open it so the tool's own
// native installer runs and the user finishes there (trusted OS prompts, no custom dialog).
#[cfg(target_os = "macos")]
fn fetch_and_open(brew: &str, cask: &str, name: &str) -> Step {
    Step {
        program: "sh".into(),
        args: vec!["-c".into(), format!("'{brew}' fetch --cask {cask} && open \"$('{brew}' --cache --cask {cask})\"")],
        note: Some(format!("Downloading {name}; its native installer will open - follow the prompts, then re-check this machine.")),
    }
}

/// The ordered install steps for a dependency on this OS.
fn plan(dep: Dependency) -> Result<Vec<Step>> {
    #[cfg(target_os = "macos")]
    {
        let brew = brew_bin().ok_or_else(|| Error::Invalid("Homebrew is required. Install it from https://brew.sh, then try again.".into()))?;
        Ok(match dep {
            // Docker Desktop: download the app with brew, then open its installer; the user
            // finishes in Docker's own flow (includes the docker CLI + compose).
            Dependency::Docker => vec![fetch_and_open(&brew, "docker-desktop", "Docker Desktop")],
            // Admin-requiring: download with brew, then open the tool's native installer.
            Dependency::Vagrant => vec![fetch_and_open(&brew, "vagrant", "Vagrant")],
            Dependency::Virtualbox => vec![fetch_and_open(&brew, "virtualbox", "VirtualBox")],
            // QEMU is a brew formula (no admin); UTM is a cask with its own installer.
            Dependency::Qemu => vec![step(brew.clone(), &["install", "qemu"])],
            Dependency::Utm => vec![fetch_and_open(&brew, "utm", "UTM")],
            Dependency::Libvirt => return Err(Error::Invalid("libvirt isn't used on macOS; use QEMU or UTM instead.".into())),
            // Cloud CLIs (brew formulae; gcloud is a cask).
            Dependency::Awscli => vec![step(brew.clone(), &["install", "awscli"])],
            Dependency::Azurecli => vec![step(brew.clone(), &["install", "azure-cli"])],
            Dependency::Gcloud => vec![step(brew.clone(), &["install", "--cask", "google-cloud-sdk"])],
        })
    }
    #[cfg(target_os = "windows")]
    {
        let id = match dep {
            Dependency::Docker => "Docker.DockerDesktop",
            Dependency::Vagrant => "Hashicorp.Vagrant",
            Dependency::Virtualbox => "Oracle.VirtualBox",
            Dependency::Qemu => "SoftwareFreedomConservancy.QEMU",
            Dependency::Utm => return Err(Error::Invalid("UTM is only available on macOS.".into())),
            Dependency::Libvirt => return Err(Error::Invalid("libvirt is Linux-only; on Windows use Hyper-V or WSL.".into())),
            Dependency::Awscli => "Amazon.AWSCLI",
            Dependency::Azurecli => "Microsoft.AzureCLI",
            Dependency::Gcloud => "Google.CloudSDK",
        };
        Ok(vec![step("winget", &["install", "-e", "--id", id, "--accept-source-agreements", "--accept-package-agreements"])])
    }
    #[cfg(target_os = "linux")]
    {
        // pkexec raises a graphical password prompt (polkit) for the privileged install.
        Ok(match dep {
            Dependency::Docker => vec![step("pkexec", &["sh", "-c", "curl -fsSL https://get.docker.com | sh"])],
            Dependency::Vagrant => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y vagrant"])],
            Dependency::Virtualbox => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y virtualbox"])],
            Dependency::Qemu => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y qemu-system qemu-utils"])],
            Dependency::Libvirt => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y libvirt-daemon-system virt-manager"])],
            Dependency::Utm => return Err(Error::Invalid("UTM is only available on macOS.".into())),
            // Cloud CLIs via each vendor's official installer (best effort across distros).
            Dependency::Awscli => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y awscli"])],
            Dependency::Azurecli => vec![step("pkexec", &["sh", "-c", "curl -sL https://aka.ms/InstallAzureCLIDeb | bash"])],
            Dependency::Gcloud => vec![step("pkexec", &["sh", "-c", "curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts"])],
        })
    }
}

async fn run_step(step: &Step, on_line: &mut impl FnMut(String)) -> Result<()> {
    if let Some(note) = &step.note {
        on_line(note.clone());
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
        if step.note.is_none() {
            on_line(format!("$ {} {}", step.program, step.args.join(" ")));
        }
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
    let step = Step { program: "vagrant".into(), args: vec!["plugin".into(), "install".into(), plugin], note: None };
    on_line(format!("$ {} {}", step.program, step.args.join(" ")));
    run_step(&step, &mut on_line).await?;
    on_line("Done. Re-checking this machine…".into());
    Ok(())
}
