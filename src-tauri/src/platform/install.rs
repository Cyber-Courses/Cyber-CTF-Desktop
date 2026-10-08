//! Assisted, one-click install of lab dependencies, streaming the package manager's output.
//! It never shows a custom password prompt: it uses the OS's own trusted flow (winget's
//! UAC, Linux pkexec, or downloading the official app/installer for macOS casks and
//! letting the tool's own installer run).

#[cfg(target_os = "macos")]
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
    Terraform,
    Virtualbox,
    Qemu,
    Utm,
    Libvirt,
    Awscli,
    Azurecli,
    Gcloud,
    /// Windows Subsystem for Linux (WSL 2), enabled through its own installer.
    Wsl,
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
// A disk image is mounted quietly and its .pkg opened in Installer, which comes to the front;
// only an app to drag into Applications (Docker Desktop, UTM) is shown in Finder, brought
// forward. Either way the log says where to finish: a window behind the app went unnoticed.
#[cfg(target_os = "macos")]
fn fetch_and_open(brew: &str, cask: &str, name: &str) -> Step {
    let script = format!(
        r#"set -e
'{brew}' fetch --cask {cask}
f="$('{brew}' --cache --cask {cask})"
case "$f" in
  *.dmg)
    m="$(hdiutil attach -nobrowse -noautoopen "$f" | awk -F'\t' '/\/Volumes\//{{print $NF; exit}}')"
    p="$(find "$m" -maxdepth 1 -name '*.pkg' | head -n 1)"
    if [ -n "$p" ]; then
      open "$p"
      echo "The {name} installer is open in its own window. Finish it there; this step updates by itself."
    else
      open "$m"
      osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1 || true
      echo "A Finder window with {name} is open. Drag it into Applications, then open it once; this step updates by itself."
    fi
    ;;
  *)
    open "$f"
    echo "The {name} installer is open in its own window. Finish it there; this step updates by itself."
    ;;
esac"#
    );
    Step { program: "sh".into(), args: vec!["-c".into(), script], note: Some(format!("Downloading {name}…")) }
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
            // Terraform is a brew formula (no admin); full tap name since core dropped it.
            Dependency::Terraform => vec![step(brew.clone(), &["install", "hashicorp/tap/terraform"])],
            Dependency::Virtualbox => vec![fetch_and_open(&brew, "virtualbox", "VirtualBox")],
            // QEMU is a brew formula (no admin); UTM is a cask with its own installer.
            Dependency::Qemu => vec![step(brew.clone(), &["install", "qemu"])],
            Dependency::Utm => vec![fetch_and_open(&brew, "utm", "UTM")],
            Dependency::Libvirt => return Err(Error::Invalid("libvirt isn't used on macOS; use QEMU or UTM instead.".into())),
            // Cloud CLIs (brew formulae; gcloud is a cask).
            Dependency::Wsl => return Err(Error::Invalid("WSL is only available on Windows.".into())),
            Dependency::Awscli => vec![step(brew.clone(), &["install", "awscli"])],
            // Microsoft's prebuilt cask instead of the `azure-cli` formula: on recent macOS the
            // formula has no bottle and builds its whole tree (llvm, rust) from source, which takes
            // ~an hour. The cask is a signed download. `trust` is needed because the tap is third-party.
            // https://learn.microsoft.com/cli/azure/install-azure-cli-macos
            Dependency::Azurecli => vec![
                step(brew.clone(), &["tap", "azure/azure-cli"]),
                step(brew.clone(), &["trust", "azure/azure-cli"]),
                Step {
                    program: brew.clone(),
                    args: vec!["install".into(), "--cask".into(), "azure-cli-preview".into()],
                    note: Some("Installing the prebuilt Azure CLI cask (avoids a long source build on this macOS).".into()),
                },
            ],
            Dependency::Gcloud => vec![step(brew.clone(), &["install", "--cask", "google-cloud-sdk"])],
        })
    }
    #[cfg(target_os = "windows")]
    {
        let id = match dep {
            Dependency::Docker => "Docker.DockerDesktop",
            Dependency::Vagrant => "Hashicorp.Vagrant",
            Dependency::Terraform => "Hashicorp.Terraform",
            Dependency::Virtualbox => "Oracle.VirtualBox",
            Dependency::Qemu => "SoftwareFreedomConservancy.QEMU",
            Dependency::Utm => return Err(Error::Invalid("UTM is only available on macOS.".into())),
            Dependency::Libvirt => return Err(Error::Invalid("libvirt is Linux-only; on Windows use Hyper-V or WSL.".into())),
            Dependency::Awscli => "Amazon.AWSCLI",
            Dependency::Azurecli => "Microsoft.AzureCLI",
            Dependency::Gcloud => "Google.CloudSDK",
            // Turns on the WSL and Virtual Machine Platform features and installs the WSL 2 kernel.
            // Elevated through Windows' own UAC prompt; the features need a restart to take effect.
            Dependency::Wsl => {
                return Ok(vec![step(
                    "powershell",
                    &["-NoProfile", "-Command", "Start-Process -FilePath wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait"],
                )]);
            }
        };
        Ok(vec![step("winget", &["install", "-e", "--id", id, "--accept-source-agreements", "--accept-package-agreements"])])
    }
    #[cfg(target_os = "linux")]
    {
        // pkexec raises a graphical password prompt (polkit) for the privileged install.
        Ok(match dep {
            Dependency::Wsl => return Err(Error::Invalid("WSL is only available on Windows.".into())),
            Dependency::Docker => vec![step("pkexec", &["sh", "-c", "curl -fsSL https://get.docker.com | sh"])],
            Dependency::Vagrant => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y vagrant"])],
            // Terraform via HashiCorp's official apt repo (best effort across Debian/Ubuntu).
            Dependency::Terraform => vec![step(
                "pkexec",
                &[
                    "sh",
                    "-c",
                    "wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg && echo \"deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main\" > /etc/apt/sources.list.d/hashicorp.list && apt-get update && apt-get install -y terraform",
                ],
            )],
            Dependency::Virtualbox => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y virtualbox"])],
            Dependency::Qemu => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y qemu-system qemu-utils"])],
            Dependency::Libvirt => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y libvirt-daemon-system virt-manager"])],
            Dependency::Utm => return Err(Error::Invalid("UTM is only available on macOS.".into())),
            // Cloud CLIs via each vendor's official installer (best effort across distros).
            // AWS CLI v2 from the official bundle: the distro `awscli` package is v1, which has no
            // `aws login` (the app needs v2 >= 2.32). `uname -m` is x86_64/aarch64, matching the URLs.
            Dependency::Awscli => vec![step(
                "pkexec",
                &[
                    "sh",
                    "-c",
                    "curl -sL \"https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip\" -o /tmp/awscliv2.zip && { command -v unzip >/dev/null || { apt-get update && apt-get install -y unzip; }; } && unzip -oq /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --update && rm -rf /tmp/awscliv2.zip /tmp/aws",
                ],
            )],
            Dependency::Azurecli => vec![step("pkexec", &["sh", "-c", "curl -sL https://aka.ms/InstallAzureCLIDeb | bash"])],
            Dependency::Gcloud => vec![step("pkexec", &["sh", "-c", "curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts"])],
        })
    }
}

async fn run_step(step: &Step, on_line: &mut impl FnMut(String)) -> Result<()> {
    if let Some(note) = &step.note {
        on_line(note.clone());
    }
    let mut cmd = Command::new(&step.program);
    cmd.args(&step.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Installers that need a console of their own (winget, an .msi) still get none here: their
    // output streams into the app's setup log instead of a window flashing on screen.
    crate::exec::headless(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
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
