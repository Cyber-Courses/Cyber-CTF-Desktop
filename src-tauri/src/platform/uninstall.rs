//! Removing what Cyber CTF installed. Each successful assisted install is recorded, and Cleanup
//! offers to remove those tools only (a Docker or Vagrant the player had before is never
//! touched). Removal goes through the same trusted flows as install: the package manager,
//! the vendor's own uninstaller, or the OS admin prompt.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::install::{Dependency, Step, run_step, step};
use crate::error::{Error, Result};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledTool {
    pub dependency: Dependency,
    /// When Cyber CTF installed it, in seconds since the Unix epoch.
    pub at: u64,
}

fn records_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("installed-tools.json"))
}

fn load(app: &AppHandle) -> Vec<InstalledTool> {
    records_file(app).and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(app: &AppHandle, tools: &[InstalledTool]) {
    if let Some(f) = records_file(app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(tools) {
            let _ = std::fs::write(f, json);
        }
    }
}

/// Remembers that Cyber CTF installed `dependency` (called after a successful install).
pub fn record(app: &AppHandle, dependency: Dependency) {
    let mut tools = load(app);
    tools.retain(|t| t.dependency != dependency);
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    tools.push(InstalledTool { dependency, at });
    save(app, &tools);
}

/// The tools Cyber CTF installed on this machine (and hasn't removed since).
#[tauri::command]
pub fn installed_tools(app: AppHandle) -> Vec<InstalledTool> {
    load(&app)
}

/// Runs a shell script with the OS admin prompt on macOS (the same dialog an installer shows).
#[cfg(target_os = "macos")]
fn mac_admin(script: &str, note: &str) -> Step {
    let escaped = script.replace('\\', "\\\\").replace('"', "\\\"");
    Step {
        program: "osascript".into(),
        args: vec!["-e".into(), format!("do shell script \"{escaped}\" with administrator privileges")],
        note: Some(note.into()),
    }
}

/// How to remove `dep` on this OS.
fn plan(dep: Dependency) -> Result<Vec<Step>> {
    #[cfg(target_os = "macos")]
    {
        let brew = super::install::brew_bin().ok_or_else(|| Error::Invalid("Homebrew is needed to remove this tool.".into()))?;
        Ok(match dep {
            Dependency::Terraform => vec![step(brew, &["uninstall", "hashicorp/tap/terraform"])],
            Dependency::Qemu => vec![step(brew, &["uninstall", "qemu"])],
            Dependency::Awscli => vec![step(brew, &["uninstall", "awscli"])],
            Dependency::Gcloud => vec![step(brew, &["uninstall", "--cask", "google-cloud-sdk"])],
            Dependency::Azurecli => vec![step(brew, &["uninstall", "--cask", "azure-cli-preview"])],
            // Installed from the vendors' own packages: removed the way their uninstallers do.
            Dependency::Vagrant => vec![mac_admin(
                "rm -rf /opt/vagrant /usr/local/bin/vagrant && pkgutil --forget com.vagrant.vagrant || true",
                "Removing Vagrant (macOS asks for your password)…",
            )],
            Dependency::Virtualbox => vec![mac_admin(
                "for v in /Volumes/VirtualBox*; do [ -x \"$v/VirtualBox_Uninstall.tool\" ] && exec \"$v/VirtualBox_Uninstall.tool\" --unattended; done; \
                 f=$(ls -t ~/Library/Caches/Homebrew/downloads/*VirtualBox*.dmg 2>/dev/null | head -n 1); [ -n \"$f\" ] || exit 3; \
                 m=$(hdiutil attach -nobrowse -noautoopen \"$f\" | awk -F'\\t' '/\\/Volumes\\//{print $NF; exit}'); \"$m/VirtualBox_Uninstall.tool\" --unattended; hdiutil detach -quiet \"$m\"",
                "Running VirtualBox's own uninstaller (macOS asks for your password)…",
            )],
            Dependency::Docker => vec![Step {
                program: "/Applications/Docker.app/Contents/MacOS/uninstall".into(),
                args: vec![],
                note: Some("Running Docker Desktop's own uninstaller…".into()),
            }],
            Dependency::Utm => vec![step("osascript", &["-e", "tell application \"Finder\" to delete POSIX file \"/Applications/UTM.app\""])],
            Dependency::Libvirt | Dependency::Wsl => return Err(Error::Invalid("Not installed on macOS.".into())),
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
            Dependency::Awscli => "Amazon.AWSCLI",
            Dependency::Azurecli => "Microsoft.AzureCLI",
            Dependency::Gcloud => "Google.CloudSDK",
            Dependency::Wsl => return Err(Error::Invalid("Turn WSL off in Windows Features if you no longer need it.".into())),
            Dependency::Utm | Dependency::Libvirt => return Err(Error::Invalid("Not installed on Windows.".into())),
        };
        Ok(vec![step("winget", &["uninstall", "-e", "--id", id])])
    }
    #[cfg(target_os = "linux")]
    {
        let root = |script: &str| step("pkexec", &["sh", "-c", script]);
        Ok(match dep {
            Dependency::Docker => vec![root("apt-get remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin")],
            Dependency::Vagrant => vec![root("apt-get remove -y vagrant")],
            Dependency::Terraform => vec![root("apt-get remove -y terraform")],
            Dependency::Virtualbox => vec![root("apt-get remove -y 'virtualbox*'")],
            Dependency::Qemu => vec![root("apt-get remove -y qemu-system qemu-utils")],
            Dependency::Libvirt => vec![root("apt-get remove -y libvirt-daemon-system virt-manager")],
            Dependency::Awscli => vec![root("rm -rf /usr/local/aws-cli /usr/local/bin/aws /usr/local/bin/aws_completer")],
            Dependency::Azurecli => vec![root("apt-get remove -y azure-cli")],
            Dependency::Gcloud => vec![step("sh", &["-c", "rm -rf \"$HOME/google-cloud-sdk\""])],
            Dependency::Utm | Dependency::Wsl => return Err(Error::Invalid("Not installed on Linux.".into())),
        })
    }
}

/// Removes a tool Cyber CTF installed, streaming the output, then forgets it.
#[tauri::command]
pub async fn uninstall_dependency(app: AppHandle, dependency: Dependency, logs: Channel<String>) -> Result<()> {
    if !load(&app).iter().any(|t| t.dependency == dependency) {
        return Err(Error::Invalid("Cyber CTF didn't install this tool, so it won't remove it.".into()));
    }
    let mut on_line = move |line: String| {
        let _ = logs.send(line);
    };
    for s in &plan(dependency)? {
        if s.note.is_none() {
            on_line(format!("$ {} {}", s.program, s.args.join(" ")));
        }
        run_step(s, &mut on_line).await?;
    }
    let mut tools = load(&app);
    tools.retain(|t| t.dependency != dependency);
    save(&app, &tools);
    on_line("Removed.".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn every_macos_tool_has_a_way_out() {
        if super::super::install::brew_bin().is_none() {
            return; // CI without Homebrew: the brew-based plans can't be built.
        }
        for dep in [
            Dependency::Docker,
            Dependency::Vagrant,
            Dependency::Terraform,
            Dependency::Virtualbox,
            Dependency::Qemu,
            Dependency::Utm,
            Dependency::Awscli,
            Dependency::Azurecli,
            Dependency::Gcloud,
        ] {
            assert!(!plan(dep).unwrap().is_empty(), "{dep:?}");
        }
        assert!(plan(Dependency::Wsl).is_err() && plan(Dependency::Libvirt).is_err());
    }
}
