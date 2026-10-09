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

#[derive(Deserialize, serde::Serialize, Clone, Copy, PartialEq, Debug)]
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

pub(crate) struct Step {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    /// A note shown before the step (e.g. when we open a download instead of installing).
    pub(crate) note: Option<String>,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn step(program: impl Into<String>, args: &[&str]) -> Step {
    Step { program: program.into(), args: args.iter().map(|s| s.to_string()).collect(), note: None }
}

#[cfg(target_os = "macos")]
pub(crate) fn brew_bin() -> Option<String> {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().find(|p| Path::new(p).exists()).map(String::from)
}

// Download the installer with brew (no admin needed), then open it so the tool's own
// native installer runs and the user finishes there (trusted OS prompts, no custom dialog).
// A disk image is mounted quietly and its .pkg opened in Installer, which comes to the front;
// only an app to drag into Applications (Docker Desktop, UTM) is shown in Finder, brought
// forward. Either way the log says where to finish: a window behind the app went unnoticed.
// `brew fetch` doesn't update Homebrew, and an old Homebrew can crash reading today's cask
// data (`undefined method 'first' for nil` in api/cask.rb), so a failed fetch updates
// Homebrew and tries once more.
#[cfg(target_os = "macos")]
fn fetch_and_open(brew: &str, cask: &str, name: &str) -> Step {
    let script = format!(
        r#"set -e
if ! '{brew}' fetch --cask {cask}; then
  echo "Homebrew couldn't download {name}. Updating Homebrew and trying again (this can take a few minutes)…"
  '{brew}' update || true
  if ! '{brew}' fetch --cask {cask}; then
    echo "Homebrew still can't download {name}. Run 'brew update' in Terminal, or install {name} from its website, then try again." >&2
    exit 1
  fi
fi
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
            Dependency::Virtualbox if std::env::consts::ARCH == "aarch64" => {
                return Err(Error::Invalid("VirtualBox doesn't run on Windows on Arm. Run VM labs with Hyper-V, on a server or in the cloud.".into()));
            }
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
        let root = |script: String| Step { program: "pkexec".into(), args: vec!["sh".into(), "-c".into(), script], note: None };
        Ok(match dep {
            Dependency::Wsl => return Err(Error::Invalid("WSL is only available on Windows.".into())),
            Dependency::Docker => vec![root(docker_script(crate::exec::login_name().as_deref()))],
            Dependency::Vagrant => vec![step("pkexec", &["sh", "-c", "apt-get update && apt-get install -y vagrant"])],
            // Terraform via HashiCorp's official apt repo (best effort across Debian/Ubuntu).
            Dependency::Terraform => vec![root(TERRAFORM_SCRIPT.into())],
            Dependency::Virtualbox => vec![root(VIRTUALBOX_SCRIPT.into())],
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
            // The SDK installs per user, without root: under pkexec it landed in /root, which the
            // player can't read. It goes to ~/google-cloud-sdk, whose bin the app adds to PATH.
            Dependency::Gcloud => vec![step("sh", &["-c", "curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts --install-dir=\"$HOME\""])],
        })
    }
}

/// HashiCorp's apt repo, then terraform. The codename is the distro's as the vendors' repos name
/// it (an Ubuntu derivative like Mint uses its Ubuntu base's). `--batch --yes`: a second run (after a partial one)
/// overwrites the keyring instead of asking on a terminal it doesn't have.
#[cfg(any(target_os = "linux", test))]
const TERRAFORM_SCRIPT: &str = concat!(
    "set -e; ",
    r#"codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"; [ -n "$codename" ] || codename="$(lsb_release -cs)""#,
    "; curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --batch --yes --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg",
    "; echo \"deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $codename main\" > /etc/apt/sources.list.d/hashicorp.list",
    "; apt-get update && apt-get install -y terraform"
);

/// The distro's own `virtualbox` when it has one (Ubuntu), else Oracle's apt repo and its
/// newest `virtualbox-X.Y` (Debian ships none in main, so `apt-get install virtualbox` failed).
#[cfg(any(target_os = "linux", test))]
const VIRTUALBOX_SCRIPT: &str = concat!(
    "set -e; apt-get update; ",
    "if apt-cache policy virtualbox 2>/dev/null | grep -q 'Candidate: [0-9]'; then apt-get install -y virtualbox; exit 0; fi; ",
    r#"codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"; [ -n "$codename" ] || codename="$(lsb_release -cs)""#,
    "; repo=https://download.virtualbox.org/virtualbox/debian",
    "; curl -fsI \"$repo/dists/$codename/Release\" >/dev/null || { echo \"Oracle has no VirtualBox packages for $codename yet. Install it from https://www.virtualbox.org/wiki/Linux_Downloads\" >&2; exit 1; }",
    "; curl -fsSL https://www.virtualbox.org/download/oracle_vbox_2016.asc | gpg --batch --yes --dearmor -o /usr/share/keyrings/oracle-virtualbox-2016.gpg",
    "; echo \"deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/oracle-virtualbox-2016.gpg] $repo $codename contrib\" > /etc/apt/sources.list.d/virtualbox.list",
    "; apt-get update",
    "; pkg=\"$(apt-cache search --names-only '^virtualbox-[0-9]+\\.[0-9]+$' | awk '{print $1}' | sort -V | tail -n 1)\"",
    "; [ -n \"$pkg\" ] || { echo \"No VirtualBox package found in Oracle's repo. Install it from https://www.virtualbox.org/wiki/Linux_Downloads\" >&2; exit 1; }",
    "; apt-get install -y \"$pkg\""
);

/// Docker's convenience script, then the player into the `docker` group so the CLI can reach
/// the daemon without root (pkexec runs as root, so `$USER` there is root: the name comes from
/// the app). The group applies from the next login.
#[cfg(any(target_os = "linux", test))]
fn docker_script(user: Option<&str>) -> String {
    let mut s = "curl -fsSL https://get.docker.com | sh".to_string();
    if let Some(u) = user.filter(|u| valid_user(u)) {
        s.push_str(&format!(" && usermod -aG docker {u} && echo 'Added {u} to the docker group: log out and back in (or restart) for it to apply.'"));
    }
    s
}

/// A login name safe to put in a shell script unquoted.
#[cfg(any(target_os = "linux", test))]
fn valid_user(u: &str) -> bool {
    !u.is_empty()
        && u.len() <= 32
        && u.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Without pkexec there is no graphical password prompt (Debian ships it apart from polkit).
pub const NO_PKEXEC: &str =
    "pkexec isn't installed, so Cyber CTF can't ask for your password. Install it once in a terminal (sudo apt install pkexec), then try again.";

/// A line pkexec prints when it, not the command, failed: refused ("Error executing command as
/// another user: Not authorized"), or no agent to ask ("…: No authentication agent found.", or,
/// with no terminal either, "Error creating textual authentication agent: …").
fn is_pkexec_error(line: &str) -> bool {
    line.starts_with("Error executing command as another user") || line.starts_with("Error creating textual authentication agent")
}

/// What to tell the player when pkexec itself refused to run the command.
fn pkexec_refusal(stderr: &str) -> &'static str {
    if stderr.contains("No authentication agent") || stderr.contains("textual authentication agent") {
        "No password prompt could be shown (no polkit agent is running). Run the command above in a terminal instead."
    } else {
        "The password prompt was cancelled or the password was refused, so nothing was changed. Try again and enter your password."
    }
}

pub(crate) async fn run_step(step: &Step, on_line: &mut impl FnMut(String)) -> Result<()> {
    if let Some(note) = &step.note {
        on_line(note.clone());
    }
    let mut cmd = Command::new(&step.program);
    cmd.args(&step.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Installers that need a console of their own (winget, an .msi) still get none here: their
    // output streams into the app's setup log instead of a window flashing on screen.
    crate::exec::headless(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound if step.program == "pkexec" => Error::Invalid(NO_PKEXEC.into()),
        std::io::ErrorKind::NotFound => Error::Invalid(format!("{} is not available on this machine.", step.program)),
        _ => Error::Io(e),
    })?;
    let mut out = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut err = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
    let (mut out_done, mut err_done) = (false, false);
    // pkexec's own failure (refused, or no agent to ask), told apart from the script's exit code.
    let mut pkexec_error: Option<String> = None;
    while !(out_done && err_done) {
        tokio::select! {
            l = out.next_line(), if !out_done => match l? { Some(x) => on_line(x), None => out_done = true },
            l = err.next_line(), if !err_done => match l? {
                Some(x) => {
                    if step.program == "pkexec" && is_pkexec_error(&x) {
                        pkexec_error = Some(x.clone());
                    }
                    on_line(x)
                }
                None => err_done = true,
            },
        }
    }
    let status = child.wait().await?;
    // pkexec exits 126 when the password prompt was dismissed or refused and 127 when no polkit
    // agent could show one, but the script's own 126/127 (a command missing or not executable)
    // come through as is: only pkexec's own message says which it was.
    if let Some(why) = pkexec_error.filter(|_| matches!(status.code(), Some(126 | 127))) {
        return Err(Error::Invalid(pkexec_refusal(&why).into()));
    }
    if !status.success() {
        return Err(Error::Invalid(format!("`{}` exited with {status}", step.program)));
    }
    Ok(())
}

/// Installs a dependency, streaming each command and its output to the UI.
#[tauri::command]
pub async fn install_dependency(app: tauri::AppHandle, dependency: Dependency, logs: Channel<String>) -> Result<()> {
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
    // Remembered so Cleanup can offer to remove what Cyber CTF installed (and only that).
    super::uninstall::record(&app, dependency);
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

#[cfg(test)]
mod tests {
    use super::{TERRAFORM_SCRIPT, VIRTUALBOX_SCRIPT, docker_script, is_pkexec_error, pkexec_refusal, valid_user};

    #[test]
    fn pkexec_refusals_name_their_cause() {
        // pkexec's own lines (polkit 126), as it prints them.
        let refused = "Error executing command as another user: Not authorized";
        let no_agent = "Error executing command as another user: No authentication agent found.";
        let no_tty =
            "Error creating textual authentication agent: Error opening current controlling terminal for the process (`/dev/tty'): No such device or address";
        assert!(is_pkexec_error(refused) && is_pkexec_error(no_agent) && is_pkexec_error(no_tty));
        assert!(pkexec_refusal(refused).contains("cancelled"));
        assert!(pkexec_refusal(no_agent).contains("polkit agent") && pkexec_refusal(no_tty).contains("polkit agent"));
        // The script's own output never passes for pkexec's.
        assert!(!is_pkexec_error("sh: 1: gpg: not found"));
    }

    #[test]
    fn docker_install_adds_the_player_to_the_docker_group() {
        let s = docker_script(Some("florianamette"));
        assert!(s.contains("get.docker.com") && s.contains("usermod -aG docker florianamette"), "{s}");
        // A name that isn't a plain login name never reaches the script.
        assert!(!docker_script(Some("a; rm -rf /")).contains("usermod"));
        assert!(!docker_script(None).contains("usermod"));
        assert!(valid_user("_svc-1.x") && !valid_user("Root") && !valid_user(""));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_failed_cask_fetch_updates_homebrew_and_retries_once() {
        // A Homebrew whose fetch always fails (an old one crashing on the cask data).
        let dir = std::env::temp_dir().join(format!("cyberctf-brew-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let brew = dir.join("brew");
        let log = dir.join("calls");
        std::fs::write(&brew, format!("#!/bin/sh\necho \"$1\" >> '{}'\n[ \"$1\" = update ]\n", log.display())).unwrap();
        std::fs::set_permissions(&brew, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

        let step = super::fetch_and_open(brew.to_str().unwrap(), "vagrant", "Vagrant");
        let out = std::process::Command::new(&step.program).args(&step.args).output().unwrap();
        let calls = std::fs::read_to_string(&log).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert!(!out.status.success());
        assert_eq!(calls.lines().collect::<Vec<_>>(), ["fetch", "update", "fetch"]);
        assert!(String::from_utf8_lossy(&out.stderr).contains("Run 'brew update' in Terminal"));
    }

    #[test]
    fn repo_scripts_rerun_without_a_terminal_and_parse() {
        // gpg asked "overwrite?" on a second run, with no tty to answer it.
        for s in [TERRAFORM_SCRIPT, VIRTUALBOX_SCRIPT] {
            assert!(s.contains("gpg --batch --yes --dearmor"), "{s}");
            let ok = std::process::Command::new("sh").args(["-n", "-c", s]).status().unwrap();
            assert!(ok.success(), "not valid sh: {s}");
        }
        assert!(VIRTUALBOX_SCRIPT.contains("download.virtualbox.org/virtualbox/debian"));
    }
}
