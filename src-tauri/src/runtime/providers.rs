//! Vagrant providers the launcher knows how to drive. Vagrant abstracts the
//! hypervisor; we only detect what is usable on this machine and pass
//! `--provider` through.

use serde::{Deserialize, Serialize};

use crate::exec::run;

/// Vagrant provider ids (the value given to `vagrant up --provider`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Virtualbox,
    VmwareDesktop,
    Hyperv,
    Parallels,
    Libvirt,
    Qemu,
    /// UTM (QEMU front end for macOS). Runs ARM guests natively on Apple
    /// Silicon and x86 guests under emulation (slow). Plugin `vagrant_utm`.
    Utm,
    /// Remote VMware ESXi host (plugin `vagrant-vmware-esxi`).
    VmwareEsxi,
    /// Remote Proxmox VE host (Terraform bpg/proxmox; plugin `vagrant-proxmox` is dead).
    Proxmox,
    /// The player's AWS account (Terraform, a lab's deploy/terraform/aws). Not a Vagrant
    /// provider and never detected locally, so it is not in `ALL`.
    Aws,
    /// The player's Azure subscription (Terraform, a lab's deploy/terraform/azure). Like
    /// AWS: not a Vagrant provider, never detected locally, not in `ALL`.
    Azure,
    /// The player's Google Cloud project (Terraform, a lab's deploy/terraform/gcp). Like
    /// AWS and Azure: not a Vagrant provider, never detected locally, not in `ALL`.
    Gcp,
}

impl Provider {
    pub const ALL: [Provider; 9] = [
        Provider::Virtualbox,
        Provider::VmwareDesktop,
        Provider::Hyperv,
        Provider::Parallels,
        Provider::Libvirt,
        Provider::Qemu,
        Provider::Utm,
        Provider::VmwareEsxi,
        Provider::Proxmox,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Virtualbox => "virtualbox",
            Provider::VmwareDesktop => "vmware_desktop",
            Provider::Hyperv => "hyperv",
            Provider::Parallels => "parallels",
            Provider::Libvirt => "libvirt",
            Provider::Qemu => "qemu",
            Provider::Utm => "utm",
            Provider::VmwareEsxi => "vmware_esxi",
            Provider::Proxmox => "proxmox",
            Provider::Aws => "aws",
            Provider::Azure => "azure",
            Provider::Gcp => "gcp",
        }
    }

    /// Remote providers run VMs on another host and need connection settings.
    pub fn is_remote(self) -> bool {
        matches!(self, Provider::VmwareEsxi | Provider::Proxmox | Provider::Aws | Provider::Azure | Provider::Gcp)
    }

    /// Whether this provider can run on the current OS at all. Local hypervisors are
    /// platform-specific; remote ones (ESXi, Proxmox) apply anywhere. We only surface
    /// providers that are possible on this machine, not the whole catalogue.
    fn applicable(self) -> bool {
        use std::env::consts::OS;
        match self {
            Provider::Hyperv => OS == "windows",
            Provider::Parallels | Provider::Utm => OS == "macos",
            Provider::Libvirt => OS == "linux",
            _ => true,
        }
    }

    /// Vagrant plugin required, if the provider is not built in.
    fn plugin(self) -> Option<&'static str> {
        match self {
            Provider::Virtualbox | Provider::Hyperv => None,
            Provider::VmwareDesktop => Some("vagrant-vmware-desktop"),
            Provider::Parallels => Some("vagrant-parallels"),
            Provider::Libvirt => Some("vagrant-libvirt"),
            Provider::Qemu => Some("vagrant-qemu"),
            Provider::Utm => Some("vagrant_utm"),
            Provider::VmwareEsxi => Some("vagrant-vmware-esxi"),
            Provider::Proxmox => Some("vagrant-proxmox"),
            Provider::Aws | Provider::Azure | Provider::Gcp => None,
        }
    }

    /// Local tool that proves the hypervisor itself is installed.
    fn probe(self) -> Option<(&'static str, &'static [&'static str])> {
        match self {
            Provider::Virtualbox => Some(("VBoxManage", &["--version"])),
            Provider::VmwareDesktop => Some(("vmrun", &[])),
            Provider::Parallels => Some(("prlctl", &["--version"])),
            Provider::Libvirt => Some(("virsh", &["--version"])),
            Provider::Qemu => Some((qemu_binary(), &["--version"])),
            // Hyper-V is a Windows feature, UTM is checked by its app bundle, and
            // remote providers have nothing local to probe.
            Provider::Hyperv | Provider::Utm | Provider::VmwareEsxi | Provider::Proxmox | Provider::Aws | Provider::Azure | Provider::Gcp => None,
        }
    }
}

const UTM_APP: &str = "/Applications/UTM.app";

fn qemu_binary() -> &'static str {
    if std::env::consts::ARCH == "aarch64" { "qemu-system-aarch64" } else { "qemu-system-x86_64" }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: Provider,
    pub remote: bool,
    pub available: bool,
    /// Whether the hypervisor itself is installed. None for remote providers (nothing
    /// local to run) and Hyper-V (a Windows feature we do not probe).
    pub hypervisor: Option<bool>,
    /// The Vagrant plugin this provider needs, if it is not built in.
    pub plugin: Option<String>,
    /// Whether that plugin is present (true when the provider is built in).
    pub plugin_installed: bool,
    /// Why it is not available (missing plugin, missing hypervisor, wrong OS).
    pub reason: Option<String>,
}

/// Plugin names from `vagrant plugin list` lines like `vagrant-libvirt (0.12.2, global)`.
pub fn parse_plugins(out: &str) -> Vec<String> {
    out.lines()
        .filter_map(|l| l.split_whitespace().next())
        .filter(|name| name.starts_with("vagrant-") || name.starts_with("vagrant_"))
        .map(str::to_string)
        .collect()
}

async fn tool_present(program: &'static str, args: &[&str]) -> bool {
    match run(program, args, None).await {
        Ok(_) => true,
        // vmrun without arguments prints usage and exits non-zero, but it exists.
        Err(crate::error::Error::CommandFailed { .. }) => true,
        Err(_) => false,
    }
}

pub async fn detect(vagrant_installed: bool) -> Vec<ProviderStatus> {
    let plugins = if vagrant_installed { run("vagrant", &["plugin", "list"], None).await.map(|o| parse_plugins(&o)).unwrap_or_default() } else { Vec::new() };

    let mut statuses = Vec::new();
    for provider in Provider::ALL {
        // Only surface providers that can run on this machine, not the whole catalogue.
        if !provider.applicable() {
            continue;
        }

        // The hypervisor layer (the VM software itself).
        let hypervisor = if provider.is_remote() || provider == Provider::Hyperv {
            None
        } else if provider == Provider::Utm {
            Some(std::path::Path::new(UTM_APP).exists())
        } else if let Some((program, args)) = provider.probe() {
            Some(tool_present(program, args).await)
        } else {
            None
        };

        // The Vagrant layer (the plugin that drives this provider).
        let plugin = provider.plugin().map(str::to_string);
        let plugin_installed = match &plugin {
            None => true, // built in to Vagrant (virtualbox, hyperv)
            Some(p) => vagrant_installed && plugins.iter().any(|i| i == p),
        };

        let reason = if !vagrant_installed {
            Some("Vagrant is not installed".to_string())
        } else if hypervisor == Some(false) {
            provider.probe().map(|(program, _)| format!("`{program}` was not found")).or_else(|| Some("not installed".to_string()))
        } else if !plugin_installed {
            plugin.as_deref().map(|p| format!("Vagrant plugin `{p}` is not installed"))
        } else {
            None
        };

        statuses.push(ProviderStatus { provider, remote: provider.is_remote(), available: reason.is_none(), hypervisor, plugin, plugin_installed, reason });
    }
    statuses
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vagrant_plugin_list() {
        let out = "vagrant-libvirt (0.12.2, global)\nvagrant_utm (0.1.3, global)\nvagrant-vmware-esxi (2.5.5, global)\n  - Version Constraint: > 0\n";
        assert_eq!(parse_plugins(out), vec!["vagrant-libvirt", "vagrant_utm", "vagrant-vmware-esxi"]);
    }

    #[test]
    fn provider_ids_match_serde_names() {
        for p in Provider::ALL {
            assert_eq!(serde_json::to_value(p).unwrap(), p.id());
        }
    }
}
