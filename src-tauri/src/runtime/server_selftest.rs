//! Server self-test: prove a host can actually run a lab, not just that it answers.
//!
//! Like the machine VM self-test, but on the player's own server: it provisions a real
//! throwaway VM on the host, waits for it to boot and accept SSH, then destroys it.
//!
//! - Proxmox: a minimal Terraform module (written here at run time, so no lab is needed)
//!   clones a Debian cloud image, cloud-init installs the guest agent and the launcher's
//!   key, Terraform waits for the agent to report an address, then `destroy` removes it.
//! - ESXi: a minimal Vagrantfile booted with `vmware_esxi`, a command run over SSH, then
//!   `vagrant destroy`.
//!
//! Progress goes to the UI as one event per step (`running`, then `ok`/`fail`), reusing the
//! machine self-test's `Event` so both share one frontend type.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::providers::Provider;
use super::{server, ssh, terraform, vm};
use crate::error::{Error, Result};
use crate::selftest::Event;

/// A throwaway VM sized to boot quickly; the point is that it boots and networks, not that
/// it is roomy.
const CORES: &str = "1";
const MEMORY_MB: &str = "1536";
const DISK_GB: &str = "4";

struct Reporter(Channel<Event>);

impl Reporter {
    fn send(&self, step: &'static str, label: &'static str, state: &'static str, detail: Option<String>) {
        let _ = self.0.send(Event { step, label, state, detail });
    }
    fn progress(&self, step: &'static str, label: &'static str, line: String) {
        let line = line.trim();
        if !line.is_empty() {
            self.send(step, label, "running", Some(line.chars().take(160).collect()));
        }
    }
    async fn step<T>(&self, step: &'static str, label: &'static str, fut: impl std::future::Future<Output = Result<(T, Option<String>)>>) -> Result<T> {
        self.send(step, label, "running", None);
        match fut.await {
            Ok((v, detail)) => {
                self.send(step, label, "ok", detail);
                Ok(v)
            }
            Err(e) => {
                self.send(step, label, "fail", Some(e.to_string()));
                Err(e)
            }
        }
    }
}

fn work_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    Ok(app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("selftest").join("server").join(id))
}

/// Runs a real-VM self-test against host `id`, streaming step events.
#[tauri::command]
pub async fn server_selftest(app: AppHandle, id: String, events: Channel<Event>) -> Result<()> {
    let r = Reporter(events);
    // `connect` resolves the host and its secret, which proves the profile and keychain are
    // usable before anything is created on the host.
    let conn = r
        .step("connect", "Reach the host", async {
            let c = server::connection(&app, &id)?;
            let name = c.name.clone();
            Ok((c, Some(name)))
        })
        .await?;

    let work = work_dir(&app, &id)?;
    let _ = std::fs::remove_dir_all(&work);

    let result = match conn.provider {
        Provider::Proxmox => proxmox(&app, &r, &conn, &work).await,
        Provider::VmwareEsxi => esxi(&r, &conn, &work).await,
        Provider::Aws => Err(Error::Invalid("the VM test is for server hosts; AWS labs are billed, so it isn't run as a test".into())),
        _ => Err(Error::Invalid("the VM test runs only on a Proxmox or ESXi host".into())),
    };

    let _ = std::fs::remove_dir_all(&work);
    result
}

// ---------- Proxmox ----------

async fn proxmox(app: &AppHandle, r: &Reporter, conn: &server::Connection, work: &Path) -> Result<()> {
    let state = work.join("state");
    let target = "proxmox-selftest";
    let pubkey = ssh::ensure_key(app).await?.1;

    r.step("prepare", "Prepare a test VM definition", async {
        write_proxmox_module(&work.join("terraform").join(target))?;
        Ok(((), None))
    })
    .await?;

    let mut vars = conn.tf_vars.clone();
    vars.push(("ssh_public_key".into(), pubkey));
    vars.push(("cores".into(), CORES.into()));
    vars.push(("memory_mb".into(), MEMORY_MB.into()));
    vars.push(("disk_gb".into(), DISK_GB.into()));

    // `apply` creates the VM and, because the agent is enabled, blocks until it boots and
    // reports an address. Terraform's own output streams as the step's detail.
    let apply = {
        let vars = vars.clone();
        let tf_env = conn.tf_env.clone();
        r.step("apply", "Create and boot the VM on the host", async {
            terraform::apply(work, &state, target, &vars, &tf_env, |l| r.progress("apply", "Create and boot the VM on the host", l)).await?;
            Ok(((), Some("VM created".into())))
        })
        .await
    };

    // Whatever happened, tear down anything that was created before returning.
    if apply.is_err() {
        destroy_proxmox(r, conn, work, &state, target).await;
        return apply;
    }

    let ip = r
        .step("boot", "VM reports a network address", async {
            match terraform::ssh_endpoint(&state) {
                Some((ip, _)) => Ok((ip.clone(), Some(ip))),
                None => Err(Error::Invalid("the VM didn't report an address (guest agent didn't answer)".into())),
            }
        })
        .await;

    if let Ok(ip) = ip {
        let _ = r
            .step("ssh", "SSH answers on the VM", async {
                wait_tcp(&ip, 22, Duration::from_secs(90)).await?;
                Ok(((), Some(format!("{ip}:22 open"))))
            })
            .await;
    }

    // Always clean up, and report it as its own step.
    destroy_proxmox(r, conn, work, &state, target).await;
    Ok(())
}

async fn destroy_proxmox(r: &Reporter, conn: &server::Connection, work: &Path, state: &Path, target: &str) {
    let _ = r
        .step("cleanup", "Destroy the test VM", async {
            terraform::destroy(work, state, target, &conn.tf_vars, &conn.tf_env, |l| r.progress("cleanup", "Destroy the test VM", l)).await?;
            Ok(((), Some("removed".into())))
        })
        .await;
}

/// Writes a minimal, self-contained Terraform module (same provider and image as a real
/// lab, no lab fetch) to `dir`.
fn write_proxmox_module(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("main.tf"), PROXMOX_MAIN_TF)?;
    std::fs::write(dir.join("variables.tf"), PROXMOX_VARS_TF)?;
    std::fs::write(dir.join("outputs.tf"), PROXMOX_OUTPUTS_TF)?;
    Ok(())
}

const PROXMOX_MAIN_TF: &str = r#"
terraform {
  required_version = ">= 1.6"
  backend "local" {}
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.115"
    }
  }
}

provider "proxmox" {
  endpoint = var.proxmox_endpoint
  username = var.proxmox_username
  password = var.proxmox_password
  insecure = var.proxmox_insecure
  ssh {
    agent    = false
    username = split("@", var.proxmox_username)[0]
    password = var.proxmox_password
    dynamic "node" {
      for_each = var.proxmox_ssh_address == "" ? [] : [var.proxmox_ssh_address]
      content {
        name    = var.proxmox_node
        address = node.value
      }
    }
  }
}

locals {
  name = "cyberctf-selftest"
}

resource "proxmox_download_file" "debian" {
  node_name           = var.proxmox_node
  datastore_id        = var.proxmox_image_storage
  content_type        = "iso"
  url                 = "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"
  file_name           = "cyberctf-debian-12-genericcloud-amd64.img"
  overwrite           = false
  overwrite_unmanaged = true
}

resource "proxmox_virtual_environment_file" "user_data" {
  node_name    = var.proxmox_node
  datastore_id = var.proxmox_snippet_storage
  content_type = "snippets"
  source_raw {
    file_name = "${local.name}-user-data.yaml"
    data = <<-EOT
      #cloud-config
      hostname: cyberctf-selftest
      ssh_authorized_keys:
        - ${var.ssh_public_key}
      packages:
        - qemu-guest-agent
      runcmd:
        - [systemctl, enable, --now, qemu-guest-agent]
    EOT
  }
}

resource "proxmox_virtual_environment_vm" "labhost" {
  name      = local.name
  node_name = var.proxmox_node
  tags      = ["cyberctf", "selftest"]
  on_boot   = false

  agent {
    enabled = true
  }
  cpu {
    cores = var.cores
    type  = var.cpu_type
  }
  memory {
    dedicated = var.memory_mb
  }
  disk {
    datastore_id = var.proxmox_storage
    file_id      = proxmox_download_file.debian.id
    interface    = "virtio0"
    size         = var.disk_gb
    discard      = "on"
  }
  network_device {
    bridge = var.proxmox_bridge
  }
  operating_system {
    type = "l26"
  }
  serial_device {}
  initialization {
    datastore_id      = var.proxmox_storage
    user_data_file_id = proxmox_virtual_environment_file.user_data.id
    ip_config {
      ipv4 {
        address = "dhcp"
      }
    }
  }
}
"#;

const PROXMOX_VARS_TF: &str = r#"
variable "proxmox_endpoint" { type = string }
variable "proxmox_username" { type = string }
variable "proxmox_password" {
  type      = string
  sensitive = true
}
variable "proxmox_insecure" {
  type    = bool
  default = false
}
variable "proxmox_ssh_address" {
  type    = string
  default = ""
}
variable "proxmox_node" {
  type    = string
  default = "pve"
}
variable "proxmox_storage" {
  type    = string
  default = "local-lvm"
}
variable "proxmox_image_storage" {
  type    = string
  default = "local"
}
variable "proxmox_snippet_storage" {
  type    = string
  default = "local"
}
variable "proxmox_bridge" {
  type    = string
  default = "vmbr0"
}
variable "ssh_public_key" {
  type    = string
  default = ""
}
variable "cpu_type" {
  type    = string
  default = "host"
}
variable "cores" {
  type    = number
  default = 1
}
variable "memory_mb" {
  type    = number
  default = 1536
}
variable "disk_gb" {
  type    = number
  default = 4
}
"#;

const PROXMOX_OUTPUTS_TF: &str = r#"
output "ssh_user" { value = "debian" }
output "vm_id" { value = proxmox_virtual_environment_vm.labhost.vm_id }
output "ip" {
  value = try([for ip in flatten(proxmox_virtual_environment_vm.labhost.ipv4_addresses) : ip if ip != "127.0.0.1"][0], null)
}
"#;

// ---------- ESXi ----------

async fn esxi(r: &Reporter, conn: &server::Connection, work: &Path) -> Result<()> {
    r.step("prepare", "Prepare a test VM definition", async {
        std::fs::create_dir_all(work)?;
        std::fs::write(work.join("Vagrantfile"), ESXI_VAGRANTFILE)?;
        Ok(((), None))
    })
    .await?;

    let up = {
        let env = conn.env.clone();
        r.step("up", "Create and boot the VM on the host", async {
            vm::start(work, Provider::VmwareEsxi, &env, |l| r.progress("up", "Create and boot the VM on the host", l)).await?;
            Ok(((), Some("VM up".into())))
        })
        .await
    };

    if up.is_err() {
        destroy_esxi(r, conn, work).await;
        return up;
    }

    let _ = r
        .step("ssh", "Run a command in the VM", async {
            let out = crate::exec::run_env("vagrant", &["ssh", "-c", "echo cyberctf-ok"], Some(work), &conn.env).await?;
            if out.contains("cyberctf-ok") {
                Ok(((), Some("command ran in the VM".into())))
            } else {
                Err(Error::Invalid("the VM didn't answer over SSH".into()))
            }
        })
        .await;

    destroy_esxi(r, conn, work).await;
    Ok(())
}

async fn destroy_esxi(r: &Reporter, conn: &server::Connection, work: &Path) {
    let _ = r
        .step("cleanup", "Destroy the test VM", async {
            vm::stop(work, &conn.env, |l| r.progress("cleanup", "Destroy the test VM", l)).await?;
            Ok(((), Some("removed".into())))
        })
        .await;
}

const ESXI_VAGRANTFILE: &str = r#"
# Minimal throwaway VM for the server self-test (no lab provisioning).
Vagrant.configure("2") do |config|
  config.vm.define "cyberctf-selftest"
  config.vm.hostname = "cyberctf-selftest"
  config.vm.box = "bento/debian-12"
  config.vm.synced_folder ".", "/vagrant", disabled: true
  config.vm.provider "vmware_esxi" do |esxi|
    esxi.esxi_hostname = ENV["CYBERCTF_ESXI_HOSTNAME"]
    esxi.esxi_hostport = Integer(ENV.fetch("CYBERCTF_ESXI_HOSTPORT", "22"))
    esxi.esxi_username = ENV.fetch("CYBERCTF_ESXI_USERNAME", "root")
    esxi.esxi_password = "env:CYBERCTF_ESXI_PASSWORD"
    esxi.esxi_disk_store = ENV["CYBERCTF_ESXI_DISK_STORE"] if ENV["CYBERCTF_ESXI_DISK_STORE"]
    esxi.esxi_virtual_network = ENV["CYBERCTF_ESXI_VIRTUAL_NETWORK"] if ENV["CYBERCTF_ESXI_VIRTUAL_NETWORK"]
    esxi.guest_numvcpus = 1
    esxi.guest_memsize = 1536
  end
end
"#;

/// Blocks until `host:port` accepts a TCP connection, or the deadline passes.
async fn wait_tcp(host: &str, port: u16, within: Duration) -> Result<()> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        match tokio::time::timeout(Duration::from_secs(4), tokio::net::TcpStream::connect((host, port))).await {
            Ok(Ok(_)) => return Ok(()),
            _ if tokio::time::Instant::now() >= deadline => return Err(Error::Invalid(format!("no answer on {host}:{port}"))),
            _ => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    }
}
