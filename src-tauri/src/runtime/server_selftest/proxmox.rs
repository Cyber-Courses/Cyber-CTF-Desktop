//! The Proxmox self-test: a throwaway VM from a minimal Terraform module (same provider and
//! image as a real lab), booted, probed over SSH, destroyed.

use std::path::Path;
use std::time::Duration;

use tauri::AppHandle;

use super::{BOOT, CLEANUP, CORES, DISK_GB, MEMORY_MB, PREPARE, Reporter, wait_tcp, wait_tcp_from};
use crate::error::{Error, Result};
use crate::runtime::{server, ssh, terraform};

const MAIN_TF: &str = include_str!("templates/main.tf");
const VARIABLES_TF: &str = include_str!("templates/variables.tf");
const OUTPUTS_TF: &str = include_str!("templates/outputs.tf");
/// Lock file for the bpg/proxmox provider, hashed for every platform the launcher runs on
/// (regenerate with `terraform providers lock -platform=linux_amd64 -platform=linux_arm64
/// -platform=darwin_amd64 -platform=darwin_arm64 -platform=windows_amd64` when bumping it).
const LOCK_HCL: &str = include_str!("templates/terraform.lock.hcl");

/// The module's folder name under the work dir (its `proxmox` component routes it to the
/// Terraform container on macOS, like a lab's Proxmox module).
const TARGET: &str = "proxmox-selftest";

pub(super) async fn run(app: &AppHandle, id: &str, r: &Reporter, conn: &server::Connection, work: &Path) -> Result<()> {
    let module = work.join("terraform").join(TARGET);
    let state = work.join("state");
    let (key, pubkey) = ssh::ensure_key(app).await?;
    // A host-internal lab bridge: the VM is only reachable from the node, so probe from there.
    let jump = server::proxmox_jump_for_host(app, id, &key, &pubkey).await?;

    r.step("prepare", PREPARE, async {
        write_module(&module)?;
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
    let apply = r
        .step("apply", BOOT, async {
            terraform::apply(&module, &state, &vars, &conn.tf_env, |l| r.progress("apply", BOOT, l)).await?;
            Ok(((), Some("VM created".into())))
        })
        .await;

    // Whatever happened, tear down anything that was created before returning.
    if apply.is_err() {
        destroy(r, conn, &module, &state).await;
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
                match &jump {
                    None => wait_tcp(&ip, 22, Duration::from_secs(90)).await?,
                    Some(login) => wait_tcp_from(login, &key, &ip, 22, Duration::from_secs(90)).await?,
                }
                Ok(((), Some(if jump.is_some() { format!("{ip}:22 open (through the node)") } else { format!("{ip}:22 open") })))
            })
            .await;
    }

    // Always clean up, and report it as its own step.
    destroy(r, conn, &module, &state).await;
    Ok(())
}

async fn destroy(r: &Reporter, conn: &server::Connection, module: &Path, state: &Path) {
    let _ = r
        .step("cleanup", CLEANUP, async {
            terraform::destroy(module, state, &conn.tf_vars, &conn.tf_env, |l| r.progress("cleanup", CLEANUP, l)).await?;
            Ok(((), Some("removed".into())))
        })
        .await;
}

/// Writes the minimal, self-contained Terraform module (no lab fetch) to `dir`.
fn write_module(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("main.tf"), MAIN_TF)?;
    std::fs::write(dir.join("variables.tf"), VARIABLES_TF)?;
    std::fs::write(dir.join("outputs.tf"), OUTPUTS_TF)?;
    // Ship a dependency lock so `terraform init` reuses the pinned provider versions/hashes
    // (reproducible, and no surprise upgrade) rather than re-resolving them. Covers every
    // platform the launcher runs on.
    std::fs::write(dir.join(".terraform.lock.hcl"), LOCK_HCL)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_module_declares_every_variable_the_test_passes() {
        for var in ["proxmox_endpoint", "proxmox_api_token", "proxmox_ssh_address", "node", "uplink_bridge", "ssh_public_key", "cores", "memory_mb", "disk_gb"]
        {
            assert!(VARIABLES_TF.contains(&format!("variable \"{var}\"")), "{var}");
        }
        assert!(OUTPUTS_TF.contains("output \"ip\""));
        assert!(LOCK_HCL.contains("registry.terraform.io/bpg/proxmox"));
    }

    #[test]
    fn write_module_lays_out_the_files() {
        let dir = std::env::temp_dir().join(format!("cyberctf-selftest-{}", rand::random::<u32>())).join(TARGET);
        write_module(&dir).unwrap();
        for f in ["main.tf", "variables.tf", "outputs.tf", ".terraform.lock.hcl"] {
            assert!(dir.join(f).is_file(), "{f}");
        }
        assert_eq!(std::fs::read_to_string(dir.join("main.tf")).unwrap(), MAIN_TF);
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
