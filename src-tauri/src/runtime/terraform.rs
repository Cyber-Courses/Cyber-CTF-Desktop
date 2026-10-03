//! Terraform targets of a lab's `deploy/terraform/<target>/` module (Proxmox home lab
//! today, AWS cloud next). Terraform runs in the official container, so players install
//! nothing: Docker is already the launcher's floor. Variables reach it as `TF_VAR_*`
//! through the container's environment (never on the command line).
//!
//! State lives outside the lab folder (`state_dir`), because reinstalling a lab at a new
//! commit replaces that folder and must not orphan the VM it created.

use std::path::Path;

use serde_json::Value;

use super::{LabStatus, Machine};
use crate::error::{Error, Result};
use crate::exec::stream;

pub const IMAGE: &str = "hashicorp/terraform:1.16.5";

/// Non-secret run parameters, kept next to the state so `destroy` can be replayed.
const RUN_FILE: &str = "run.json";

fn docker_args(deploy: &Path, state: &Path, target: &str, env: &[(String, String)], script: &str) -> Vec<String> {
    let mut args = vec![
        "run".into(),
        "--rm".into(),
        "--entrypoint".into(),
        "sh".into(),
        "-v".into(),
        format!("{}:/deploy:ro", deploy.display()),
        "-v".into(),
        format!("{}:/state", state.display()),
        "-w".into(),
        format!("/deploy/terraform/{target}"),
        "-e".into(),
        "TF_DATA_DIR=/state/.terraform".into(),
        "-e".into(),
        "TF_IN_AUTOMATION=1".into(),
    ];
    // `-e NAME` without a value: docker copies it from its own environment, so secrets
    // never appear in the process list.
    for (name, _) in env {
        args.push("-e".into());
        args.push(name.clone());
    }
    args.push(IMAGE.into());
    args.push("-c".into());
    args.push(script.into());
    args
}

const INIT: &str = "terraform init -input=false -no-color -lockfile=readonly -backend-config=path=/state/terraform.tfstate";

async fn terraform(deploy: &Path, state: &Path, target: &str, env: &[(String, String)], command: &str, log: impl FnMut(String)) -> Result<()> {
    if !deploy.join("terraform").join(target).is_dir() {
        return Err(Error::Invalid(format!("this lab has no `{target}` deployment yet")));
    }
    std::fs::create_dir_all(state)?;
    let script = format!("{INIT} >/dev/null && terraform {command} -auto-approve -input=false -no-color");
    let args = docker_args(deploy, state, target, env, &script);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    stream("docker", &args, None, env, log).await
}

/// Creates (or updates) the target's resources. `vars` are Terraform variable names.
pub async fn apply(deploy: &Path, state: &Path, target: &str, vars: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    std::fs::create_dir_all(state)?;
    // Remember the non-secret variables, so a later destroy has them without the launch spec.
    let run: serde_json::Map<String, Value> = vars
        .iter()
        .filter(|(k, _)| matches!(k.as_str(), "lab_slug" | "lab_repository" | "lab_commit"))
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    std::fs::write(state.join(RUN_FILE), serde_json::to_string(&run).unwrap_or_default())?;
    terraform(deploy, state, target, &tf_env(vars), "apply", log).await
}

/// Destroys everything the target created. `vars` carry the connection again (the
/// provider needs it); the lab variables are restored from the last apply.
pub async fn destroy(deploy: &Path, state: &Path, target: &str, vars: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    if !state.join("terraform.tfstate").is_file() {
        return Ok(());
    }
    let mut all: Vec<(String, String)> = vars.to_vec();
    if let Ok(raw) = std::fs::read_to_string(state.join(RUN_FILE)) {
        if let Ok(Value::Object(run)) = serde_json::from_str::<Value>(&raw) {
            for (k, v) in run {
                if let Some(v) = v.as_str() {
                    all.push((k, v.to_string()));
                }
            }
        }
    }
    terraform(deploy, state, target, &tf_env(&all), "destroy", log).await?;
    let _ = std::fs::remove_file(state.join("terraform.tfstate"));
    Ok(())
}

fn tf_env(vars: &[(String, String)]) -> Vec<(String, String)> {
    vars.iter().map(|(k, v)| (format!("TF_VAR_{k}"), v.clone())).collect()
}

/// The lab host's address and SSH user, from the local state's outputs.
pub fn ssh_endpoint(state: &Path) -> Option<(String, String)> {
    let raw = std::fs::read_to_string(state.join("terraform.tfstate")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let ip = v["outputs"]["ip"]["value"].as_str().filter(|s| !s.is_empty())?.to_string();
    let user = v["outputs"]["ssh_user"]["value"].as_str().unwrap_or("debian").to_string();
    Some((ip, user))
}

/// Status from the local state's outputs (no container run, so it's cheap to poll).
pub fn status(state: &Path) -> LabStatus {
    let outputs = std::fs::read_to_string(state.join("terraform.tfstate"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|v| v["outputs"].clone())
        .unwrap_or(Value::Null);
    let created = !outputs["vm_id"]["value"].is_null() || !outputs["instance_id"]["value"].is_null();
    let ip = outputs["ip"]["value"].as_str().unwrap_or_default().to_string();
    let machines = if created {
        vec![Machine { name: "labhost".into(), state: "running".into(), image: String::new(), ip, ports: Vec::new() }]
    } else {
        Vec::new()
    };
    LabStatus { running: created, machines, url: None, host: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_go_through_the_environment_not_argv() {
        let env = vec![("TF_VAR_proxmox_password".to_string(), "s3cret".to_string())];
        let args = docker_args(Path::new("/lab/deploy"), Path::new("/st"), "proxmox", &env, "terraform apply");
        assert!(args.iter().any(|a| a == "TF_VAR_proxmox_password"));
        assert!(!args.iter().any(|a| a.contains("s3cret")));
        assert!(args.contains(&"/lab/deploy:/deploy:ro".to_string()));
    }

    #[test]
    fn status_reads_outputs_from_state() {
        let dir = std::env::temp_dir().join(format!("cyberctf-tf-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!status(&dir).running);
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{"vm_id":{"value":100},"ip":{"value":"10.10.10.150"}}}"#).unwrap();
        let s = status(&dir);
        assert!(s.running);
        assert_eq!(s.machines[0].ip, "10.10.10.150");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The launcher's Proxmox path against a real host (opt-in, slow):
    ///   CYBERCTF_TEST_DEPLOY=<lab>/deploy CYBERCTF_TEST_PVE_HOST=... CYBERCTF_TEST_PVE_PASSWORD=... \
    ///   CYBERCTF_TEST_LAB_COMMIT=<sha> cargo test proxmox_apply_status_destroy -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn proxmox_apply_status_destroy() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is required"));
        let host = var("CYBERCTF_TEST_PVE_HOST");
        let state = std::env::temp_dir().join(format!("cyberctf-tf-it-{}", rand::random::<u32>()));
        // A copy of deploy/, so a host without KVM can create the VM without starting it
        // (CYBERCTF_TEST_PVE_NO_START) through a Terraform override file.
        let deploy = std::env::temp_dir().join(format!("cyberctf-deploy-it-{}", rand::random::<u32>()));
        let copied = std::process::Command::new("cp").arg("-R").arg(var("CYBERCTF_TEST_DEPLOY")).arg(&deploy).status().unwrap();
        assert!(copied.success());
        let _ = std::fs::remove_dir_all(deploy.join("terraform/proxmox/.terraform"));
        if std::env::var("CYBERCTF_TEST_PVE_NO_START").is_ok() {
            std::fs::write(
                deploy.join("terraform/proxmox/test_override.tf"),
                "resource \"proxmox_virtual_environment_vm\" \"labhost\" {\n  started = false\n}\n",
            )
            .unwrap();
        }
        let mut vars: Vec<(String, String)> = [
            ("proxmox_endpoint", format!("https://{host}:8006/")),
            ("proxmox_username", "root@pam".into()),
            ("proxmox_password", var("CYBERCTF_TEST_PVE_PASSWORD")),
            ("proxmox_insecure", "true".into()),
            ("proxmox_ssh_address", host.clone()),
            ("proxmox_storage", std::env::var("CYBERCTF_TEST_PVE_STORAGE").unwrap_or_else(|_| "local".into())),
            ("cpu_type", std::env::var("CYBERCTF_TEST_PVE_CPU").unwrap_or_else(|_| "host".into())),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let connection = vars.clone();
        vars.extend([
            ("lab_slug".to_string(), "invoice-portal-api".to_string()),
            ("lab_repository".into(), "CyberCTF/invoice-portal-api".into()),
            ("lab_commit".into(), var("CYBERCTF_TEST_LAB_COMMIT")),
        ]);
        let print = |l: String| println!("{l}");

        let applied = apply(&deploy, &state, "proxmox", &vars, print).await;
        let s = status(&state);
        println!("status after apply: running={} machines={}", s.running, s.machines.len());
        let destroyed = destroy(&deploy, &state, "proxmox", &connection, print).await;
        let after = status(&state);
        let _ = std::fs::remove_dir_all(&state);
        let _ = std::fs::remove_dir_all(&deploy);
        applied.expect("apply");
        assert!(s.running, "state outputs should show the VM");
        destroyed.expect("destroy");
        assert!(!after.running, "state should be gone after destroy");
    }
}
