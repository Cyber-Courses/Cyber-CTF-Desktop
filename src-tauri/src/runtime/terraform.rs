//! Terraform runs of a lab's Isoloom module (`.isoloom/docker-vm/proxmox`, `.isoloom/proxmox`,
//! `.isoloom/cloud-docker/<cloud>`: Proxmox servers and the clouds). A local `terraform` binary is required; state is kept as plain
//! files on the host. A containerised terraform would be simpler to ship but couldn't reach the
//! host's cloud CLI auth (`~/.aws`, `az login` / `~/.azure`, gcloud ADC), so the cloud targets
//! need the host binary. Variables reach it as `TF_VAR_*` through the environment (never on the
//! command line).
//!
//! State lives outside the lab folder (`state_dir`), because reinstalling a lab at a new
//! commit replaces that folder and must not orphan the VM it created.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{LabStatus, Machine, ssh};
use crate::error::{Error, Result};
use crate::exec::{run, stream};

/// Non-secret run parameters, kept next to the state so `destroy` can be replayed.
const RUN_FILE: &str = "run.json";
const EXPIRES_AT: &str = "expires_at";

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

async fn terraform(module: &Path, state: &Path, env: &[(String, String)], command: &str, log: impl FnMut(String)) -> Result<()> {
    if !module.join("main.tf").is_file() {
        return Err(Error::Invalid(format!("this lab has no Terraform module at {}", module.display())));
    }
    if run("terraform", &["version"], None).await.is_err() {
        return Err(Error::Invalid("Terraform isn't installed. Install it from the server setup (Tools on this machine).".into()));
    }
    std::fs::create_dir_all(state)?;
    terraform_host(module, state, env, command, log).await
}

/// Runs terraform from the host PATH (init, then the command). State lives in `state` as
/// plain files on the host.
async fn terraform_host(dir: &Path, state: &Path, env: &[(String, String)], command: &str, mut log: impl FnMut(String)) -> Result<()> {
    let backend = format!("-backend-config=path={}", state.join("terraform.tfstate").display());
    let mut full = env.to_vec();
    full.push(("TF_DATA_DIR".to_string(), state.join(".terraform").display().to_string()));
    full.push(("TF_IN_AUTOMATION".to_string(), "1".to_string()));
    // Isoloom pins provider versions in the module; the lock file is written next to it.
    stream("terraform", &["init", "-input=false", "-no-color", backend.as_str()], Some(dir), &full, &mut log).await?;
    stream("terraform", &[command, "-auto-approve", "-input=false", "-no-color"], Some(dir), &full, log).await
}

/// Creates (or updates) the target's resources. `vars` are Terraform variable names;
/// `env` is raw environment the provider reads itself (cloud credentials).
pub async fn apply(module: &Path, state: &Path, vars: &[(String, String)], env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    std::fs::create_dir_all(state)?;
    // Remember the non-secret variables, so a later destroy has them without the launch spec.
    let mut run: serde_json::Map<String, Value> = vars
        .iter()
        .filter(|(k, _)| matches!(k.as_str(), "ssh_public_key" | "ssh_private_key_file" | "allowed_cidr"))
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    // When the lab host stops itself (cloud auto-stop), so status can tell.
    if let Some(hours) = vars.iter().find(|(k, _)| k == "auto_stop_hours").and_then(|(_, v)| v.parse::<u64>().ok()).filter(|h| *h > 0) {
        run.insert(EXPIRES_AT.into(), Value::from(now() + hours * 3600));
    }
    std::fs::write(state.join(RUN_FILE), serde_json::to_string(&run).unwrap_or_default())?;
    let mut log = log;
    let vars = with_ssh_key(vars, ssh::launcher_key());
    terraform(module, state, &with_env(&vars, env), "apply", &mut log).await?;
    wait_ready(state, &mut log).await
}

/// How long the lab host may take to install Docker and start the lab after boot.
const READY_TIMEOUT: Duration = Duration::from_secs(40 * 60);
/// Give up on confirming (not on the lab) when SSH never answers this long.
const SSH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL: Duration = Duration::from_secs(10);

/// The bootstrap's report, read from the lab host.
#[derive(Debug, PartialEq)]
enum Progress {
    Running(String),
    Ready,
    Failed(String),
}

/// First line of `cat <ready_file>`: "running: <step>", "ready" or "failed: <step>".
fn parse_progress(first_line: &str) -> Progress {
    let line = first_line.trim();
    if line == "ready" {
        Progress::Ready
    } else if let Some(step) = line.strip_prefix("failed:") {
        Progress::Failed(step.trim().to_string())
    } else {
        Progress::Running(line.strip_prefix("running:").unwrap_or("booting").trim().to_string())
    }
}

/// After apply the VM exists, but cloud-init is still installing Docker and starting the
/// lab. Waits for the bootstrap's `ready_file` over SSH, so "running" means the lab is up,
/// and a failed bootstrap fails the launch with its log. Modules without a `ready_file`
/// output (older labs) are not waited on.
async fn wait_ready(state: &Path, log: &mut impl FnMut(String)) -> Result<()> {
    let Some(ready_file) = output(state, "ready_file") else { return Ok(()) };
    let (Some(identity), Some((host, user))) = (ssh::launcher_key(), ssh_endpoint(state)) else {
        log("Can't reach the lab host over SSH to confirm it started; check it from the lab page.".into());
        return Ok(());
    };
    let target = ssh::Target { host, port: 22, user, identity };
    let known_hosts = state.join("known_hosts");
    let command = format!("cat {} 2>/dev/null || true; echo; tail -n 25 /var/log/cyberctf-lab.log 2>/dev/null || true", ssh::sh_quote(&ready_file));

    log("Waiting for the lab host to install Docker and start the lab…".into());
    let started = Instant::now();
    let mut reached = false;
    let mut last_step = String::new();
    loop {
        match target.exec(&known_hosts, &command).await {
            Ok(out) => {
                reached = true;
                let mut lines = out.lines();
                match parse_progress(lines.next().unwrap_or_default()) {
                    Progress::Ready => {
                        log("Lab host ready.".into());
                        return Ok(());
                    }
                    Progress::Failed(step) => {
                        let tail: Vec<&str> = lines.filter(|l| !l.trim().is_empty()).collect();
                        return Err(Error::CommandFailed { command: format!("lab host: {step}"), stderr: tail.join("\n") });
                    }
                    Progress::Running(step) => {
                        if step != last_step {
                            log(format!("Lab host: {step}…"));
                            last_step = step;
                        }
                    }
                }
            }
            Err(_) if !reached && started.elapsed() >= SSH_TIMEOUT => {
                log("The lab host doesn't answer over SSH, so the launcher can't confirm the lab started. It may still be starting; check it from the lab page.".into());
                return Ok(());
            }
            // Booting (SSH not up yet) or a dropped connection: try again.
            Err(_) => {}
        }
        if started.elapsed() >= READY_TIMEOUT {
            return Err(Error::Invalid(format!(
                "the lab host didn't finish starting the lab within {} minutes (last step: {})",
                READY_TIMEOUT.as_secs() / 60,
                if last_step.is_empty() { "booting" } else { &last_step }
            )));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// A string output from the local state.
fn output(state: &Path, name: &str) -> Option<String> {
    let raw = std::fs::read_to_string(state.join("terraform.tfstate")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v["outputs"][name]["value"].as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// Destroys everything the target created. `vars` carry the connection again (the
/// provider needs it); the lab variables are restored from the last apply.
pub async fn destroy(module: &Path, state: &Path, vars: &[(String, String)], env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    if !state.join("terraform.tfstate").is_file() {
        return Ok(());
    }
    let mut all: Vec<(String, String)> = vars.to_vec();
    if let Ok(raw) = std::fs::read_to_string(state.join(RUN_FILE))
        && let Ok(Value::Object(run)) = serde_json::from_str::<Value>(&raw)
    {
        for (k, v) in run {
            // Strings only: lab variables (expires_at is a number).
            if let Some(v) = v.as_str() {
                all.push((k, v.to_string()));
            }
        }
    }
    // Modules validate the SSH key even to destroy (older runs didn't save it): the launcher's.
    if !all.iter().any(|(k, _)| k == "ssh_public_key")
        && let Some(public) = ssh::launcher_key().and_then(|k| std::fs::read_to_string(k.with_extension("pub")).ok())
    {
        all.push(("ssh_public_key".into(), public.trim().to_string()));
    }
    if !all.iter().any(|(k, _)| k == "ssh_private_key_file")
        && let Some(key) = ssh::launcher_key()
    {
        all.push(("ssh_private_key_file".into(), key.to_string_lossy().to_string()));
    }
    terraform(module, state, &with_env(&all, env), "destroy", log).await?;
    let _ = std::fs::remove_file(state.join("terraform.tfstate"));
    Ok(())
}

/// Proxmox token setups upload the cloud-init snippet over SSH with the launcher's key
/// (a token can't SSH): point the module at it.
fn with_ssh_key(vars: &[(String, String)], key: Option<std::path::PathBuf>) -> Vec<(String, String)> {
    let mut out = vars.to_vec();
    let token = vars.iter().any(|(k, v)| k == "proxmox_api_token" && !v.is_empty());
    let set = vars.iter().any(|(k, _)| k == "proxmox_ssh_private_key_file");
    if let (true, false, Some(key)) = (token, set, key) {
        out.push(("proxmox_ssh_private_key_file".into(), key.to_string_lossy().to_string()));
    }
    out
}

fn with_env(vars: &[(String, String)], env: &[(String, String)]) -> Vec<(String, String)> {
    vars.iter().map(|(k, v)| (format!("TF_VAR_{k}"), v.clone())).chain(env.iter().cloned()).collect()
}

/// The lab host's address and SSH user, from the local state's outputs.
pub fn ssh_endpoint(state: &Path) -> Option<(String, String)> {
    let raw = std::fs::read_to_string(state.join("terraform.tfstate")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let ip = v["outputs"]["ip"]["value"].as_str().filter(|s| !s.is_empty())?.to_string();
    let user = v["outputs"]["ssh_user"]["value"].as_str().unwrap_or("isoloom").to_string();
    Some((ip, user))
}

/// Status from the local state's outputs (no container run, so it's cheap to poll).
pub fn status(state: &Path) -> LabStatus {
    let outputs = std::fs::read_to_string(state.join("terraform.tfstate"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|v| v["outputs"].clone())
        .unwrap_or(Value::Null);
    let expires_at =
        std::fs::read_to_string(state.join(RUN_FILE)).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| v[EXPIRES_AT].as_u64());
    // Past its auto-stop, the cloud instance has terminated itself.
    let expired = expires_at.is_some_and(|t| now() >= t);
    let created = has_instance(&outputs) && !expired;
    let ip = outputs["ip"]["value"].as_str().unwrap_or_default().to_string();
    let machines = if created {
        vec![Machine {
            name: "labhost".into(),
            state: "running".into(),
            image: String::new(),
            ip,
            ports: Vec::new(),
            interfaces: Vec::new(),
            services: Vec::new(),
        }]
    } else {
        Vec::new()
    };
    LabStatus { running: created, machines, networks: Vec::new(), url: None, host: None, expires_at: expires_at.filter(|_| created), place: None }
}

/// The state holds a lab host: Isoloom modules output its `ip`.
fn has_instance(outputs: &Value) -> bool {
    outputs["ip"]["value"].as_str().is_some_and(|ip| !ip.is_empty())
}

/// True when the state still holds a cloud instance whose auto-stop time has passed, so it
/// needs a `destroy` to free the resources and end billing (an OS poweroff does not deallocate
/// on Azure). Unlike `status`, this stays true after expiry; it's the signal the reaper uses.
pub fn expired(state: &Path) -> bool {
    let outputs = std::fs::read_to_string(state.join("terraform.tfstate"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|v| v["outputs"].clone())
        .unwrap_or(Value::Null);
    let has_instance = has_instance(&outputs);
    let expires_at =
        std::fs::read_to_string(state.join(RUN_FILE)).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| v[EXPIRES_AT].as_u64());
    has_instance && expires_at.is_some_and(|t| now() >= t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_env_prefixes_vars_and_appends_raw_env() {
        let vars = vec![("region".to_string(), "eu-west-3".to_string())];
        let env = vec![("AWS_ACCESS_KEY_ID".to_string(), "AKIA".to_string())];
        let out = with_env(&vars, &env);
        assert!(out.contains(&("TF_VAR_region".to_string(), "eu-west-3".to_string())));
        assert!(out.contains(&("AWS_ACCESS_KEY_ID".to_string(), "AKIA".to_string())));
    }

    #[test]
    fn token_setups_get_the_launcher_key() {
        let key = Some(std::path::PathBuf::from("/k/id_ed25519"));
        let token = vec![("proxmox_api_token".to_string(), "root@pam!x=s".to_string())];
        assert!(with_ssh_key(&token, key.clone()).contains(&("proxmox_ssh_private_key_file".into(), "/k/id_ed25519".into())));
        let password = vec![("proxmox_password".to_string(), "p".to_string())];
        assert_eq!(with_ssh_key(&password, key), password);
    }

    #[test]
    fn parses_bootstrap_progress() {
        assert_eq!(parse_progress("ready\n"), Progress::Ready);
        assert_eq!(parse_progress("running: downloading the lab"), Progress::Running("downloading the lab".into()));
        assert_eq!(parse_progress("failed: starting the lab"), Progress::Failed("starting the lab".into()));
        // No status file yet: cloud-init hasn't reached the bootstrap.
        assert_eq!(parse_progress(""), Progress::Running("booting".into()));
    }

    #[tokio::test]
    async fn no_ready_file_output_means_no_wait() {
        let dir = std::env::temp_dir().join(format!("cyberctf-tf-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{"ip":{"value":"10.0.0.9"}}}"#).unwrap();
        let mut lines = Vec::new();
        wait_ready(&dir, &mut |l| lines.push(l)).await.unwrap();
        assert!(lines.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn status_reads_outputs_from_state() {
        let dir = std::env::temp_dir().join(format!("cyberctf-tf-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!status(&dir).running);
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{"ip":{"value":"10.10.10.150"}}}"#).unwrap();
        let s = status(&dir);
        assert!(s.running);
        assert_eq!(s.machines[0].ip, "10.10.10.150");
        // Auto-stop: shown while pending, stopped once past.
        std::fs::write(dir.join(RUN_FILE), format!(r#"{{"expires_at":{}}}"#, now() + 3600)).unwrap();
        assert!(status(&dir).running && status(&dir).expires_at.is_some());
        std::fs::write(dir.join(RUN_FILE), r#"{"expires_at":1}"#).unwrap();
        assert!(!status(&dir).running);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The launcher's Proxmox path against a real host (opt-in, slow), with a lab's Isoloom
    /// module (Docker on one VM):
    ///   CYBERCTF_TEST_MODULE=<lab>/.isoloom/docker-vm/proxmox CYBERCTF_TEST_PVE_HOST=... \
    ///   CYBERCTF_TEST_PVE_PASSWORD=... cargo test proxmox_apply_status_destroy -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn proxmox_apply_status_destroy() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is required"));
        let host = var("CYBERCTF_TEST_PVE_HOST");
        let state = std::env::temp_dir().join(format!("cyberctf-tf-it-{}", rand::random::<u32>()));
        let module = std::path::PathBuf::from(var("CYBERCTF_TEST_MODULE"));
        let (key, public) = (var("CYBERCTF_TEST_SSH_KEY"), std::fs::read_to_string(format!("{}.pub", var("CYBERCTF_TEST_SSH_KEY"))).unwrap());
        let connection: Vec<(String, String)> = [
            ("proxmox_endpoint", format!("https://{host}:8006/")),
            ("proxmox_username", "root@pam".into()),
            ("proxmox_password", var("CYBERCTF_TEST_PVE_PASSWORD")),
            ("proxmox_insecure", "true".into()),
            ("node", std::env::var("CYBERCTF_TEST_PVE_NODE").unwrap_or_else(|_| "pve".into())),
            ("datastore", std::env::var("CYBERCTF_TEST_PVE_STORAGE").unwrap_or_else(|_| "local".into())),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let mut vars = connection.clone();
        vars.extend([("ssh_public_key".to_string(), public.trim().to_string()), ("ssh_private_key_file".into(), key)]);
        let print = |l: String| println!("{l}");

        let applied = apply(&module, &state, &vars, &[], print).await;
        let s = status(&state);
        println!("status after apply: running={} machines={}", s.running, s.machines.len());
        let destroyed = destroy(&module, &state, &connection, &[], print).await;
        let after = status(&state);
        let _ = std::fs::remove_dir_all(&state);
        applied.expect("apply");
        assert!(s.running, "state outputs should show the VM");
        destroyed.expect("destroy");
        assert!(!after.running, "state should be gone after destroy");
    }
}
