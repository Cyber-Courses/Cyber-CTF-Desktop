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
use crate::exec::{run_read, stream};

/// Whether any resource instance in a Terraform state is tainted (a create or provisioner failed).
fn has_tainted(state: &Value) -> bool {
    state["resources"]
        .as_array()
        .is_some_and(|rs| rs.iter().any(|r| r["instances"].as_array().is_some_and(|is| is.iter().any(|i| i["status"].as_str() == Some("tainted")))))
}

/// Non-secret run parameters, kept next to the state so `destroy` can be replayed.
const RUN_FILE: &str = "run.json";
const EXPIRES_AT: &str = "expires_at";

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The non-secret run record written beside the state at apply time, so a later destroy can be
/// replayed without the launch spec: the connection/key variables plus, for auto-stopping cloud
/// hosts, the computed `expires_at` (seconds since epoch; `now` is the current time).
fn run_record(vars: &[(String, String)], now: u64) -> serde_json::Map<String, Value> {
    let mut run: serde_json::Map<String, Value> = vars
        .iter()
        .filter(|(k, _)| matches!(k.as_str(), "ssh_public_key" | "ssh_private_key_file" | "allowed_cidr"))
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    // When the lab host stops itself (cloud auto-stop), so status can tell.
    if let Some(hours) = vars.iter().find(|(k, _)| k == "auto_stop_hours").and_then(|(_, v)| v.parse::<u64>().ok()).filter(|h| *h > 0) {
        run.insert(EXPIRES_AT.into(), Value::from(now + hours * 3600));
    }
    run
}

/// Lab variables restored from the run record for a destroy. Strings only: the lab variables
/// the provider needs again (`expires_at` is a number and is skipped). A missing or malformed
/// record yields nothing, never an error.
fn saved_vars(run_json: &str) -> Vec<(String, String)> {
    match serde_json::from_str::<Value>(run_json) {
        Ok(Value::Object(run)) => run.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect(),
        _ => Vec::new(),
    }
}

async fn terraform(module: &Path, state: &Path, env: &[(String, String)], command: &str, log: impl FnMut(String)) -> Result<()> {
    if !module.join("main.tf").is_file() {
        return Err(Error::Invalid(format!("this lab has no Terraform module at {}", module.display())));
    }
    if run_read("terraform", &["version"], None).await.is_err() {
        return Err(Error::Invalid("Terraform isn't installed. Install it from the server setup (Tools on this machine).".into()));
    }
    std::fs::create_dir_all(state)?;
    // A crashed or killed terraform can leave the local backend's lock file behind. The launcher
    // serializes operations on a lab (lab_lock) and is the only writer of this state, so any lock
    // present now is stale and would otherwise block this op with "Error acquiring the state
    // lock". Clear it before init.
    let _ = std::fs::remove_file(state.join(".terraform.tfstate.lock.info"));
    if in_container(module).await {
        return terraform_container(module, state, env, command, log).await;
    }
    terraform_host(module, state, env, command, log).await
}

/// The Terraform image for runs that can't use the host binary.
const TERRAFORM_IMAGE: &str = "hashicorp/terraform:1.9.8";

/// macOS lets an app reach the local network but not the third-party tools it starts: Terraform's
/// Proxmox provider got "no route to host" to a LAN server the app itself could reach (even with
/// Cyber CTF allowed under Local Network), while Docker Desktop, an allowed app, carries container
/// traffic fine. So on macOS a Proxmox module runs in the Terraform container when Docker answers.
/// Clouds keep the host binary (they need the host's CLI logins, and the internet isn't affected).
async fn in_container(module: &Path) -> bool {
    cfg!(target_os = "macos")
        && module.components().any(|c| c.as_os_str() == "proxmox")
        && run_read("docker", &["info", "--format", "{{.ServerVersion}}"], None).await.is_ok()
}

/// The lab folder a module belongs to: the parent of its `.isoloom…` folder (the module itself
/// when it isn't under one).
fn lab_root(module: &Path) -> &Path {
    module.ancestors().find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(".isoloom"))).and_then(Path::parent).unwrap_or(module)
}

/// Runs terraform in the official image, with the module, its state and the files the variables
/// name mounted at their own paths (so every path in the module and the state stays valid), and
/// the variables passed through the environment (`-e NAME`, never their values on a command line).
async fn terraform_container(dir: &Path, state: &Path, env: &[(String, String)], command: &str, mut log: impl FnMut(String)) -> Result<()> {
    let mut full = env.to_vec();
    full.push(("TF_DATA_DIR".to_string(), state.join(".terraform").display().to_string()));
    full.push(("TF_IN_AUTOMATION".to_string(), "1".to_string()));
    // The whole lab, not just the module: Isoloom modules reach the rest of the lab through
    // `path.module/..` (the Proxmox module tars the lab folder to upload it; mounting only the
    // module left the archive without the lab's compose file).
    let mut mounts: Vec<String> = vec![lab_root(dir).display().to_string(), state.display().to_string()];
    // Files a variable points at (the SSH key), by their folder.
    for (_, v) in env.iter().filter(|(k, _)| k.ends_with("_file")) {
        if let Some(parent) = Path::new(v).parent().filter(|p| p.is_absolute()) {
            mounts.push(parent.display().to_string());
        }
    }
    mounts.sort();
    mounts.dedup();
    let backend = format!("-backend-config=path={}", state.join("terraform.tfstate").display());
    let workdir = dir.display().to_string();
    let run = |tf_args: Vec<String>| {
        let mut args: Vec<String> = vec!["run".into(), "--rm".into(), "-i".into(), "-w".into(), workdir.clone()];
        for m in &mounts {
            args.extend(["-v".into(), format!("{m}:{m}")]);
        }
        for (k, _) in &full {
            args.extend(["-e".into(), k.clone()]);
        }
        args.push(TERRAFORM_IMAGE.into());
        args.extend(tf_args);
        args
    };
    log("Running Terraform in its container (macOS keeps third-party tools off the local network).".into());
    let init = run(vec!["init".into(), "-input=false".into(), "-no-color".into(), backend]);
    let init_refs: Vec<&str> = init.iter().map(String::as_str).collect();
    stream("docker", &init_refs, Some(dir), &full, &mut log).await?;
    let cmd = run(vec![command.into(), "-auto-approve".into(), "-input=false".into(), "-no-color".into()]);
    let cmd_refs: Vec<&str> = cmd.iter().map(String::as_str).collect();
    stream("docker", &cmd_refs, Some(dir), &full, log).await
}

/// Runs terraform from the host PATH (init, then the command). State lives in `state` as
/// plain files on the host.
async fn terraform_host(dir: &Path, state: &Path, env: &[(String, String)], command: &str, mut log: impl FnMut(String)) -> Result<()> {
    let backend = format!("-backend-config=path={}", state.join("terraform.tfstate").display());
    let mut full = env.to_vec();
    full.push(("TF_DATA_DIR".to_string(), state.join(".terraform").display().to_string()));
    full.push(("TF_IN_AUTOMATION".to_string(), "1".to_string()));
    // Isoloom pins provider versions in the module; the lock file is written next to it. init
    // downloads the provider plugins the first time, which needs the network; say so plainly if
    // that's what failed (otherwise a destroy of an existing lab can look impossible when it's
    // just offline).
    stream("terraform", &["init", "-input=false", "-no-color", backend.as_str()], Some(dir), &full, &mut log).await.map_err(init_error)?;
    stream("terraform", &[command, "-auto-approve", "-input=false", "-no-color"], Some(dir), &full, log).await
}

/// An init that failed for want of the network, said plainly.
fn init_error(e: Error) -> Error {
    let s = e.to_string().to_lowercase();
    if ["registry", "no such host", "timeout", "tls", "connection", "network is unreachable", "could not download"].iter().any(|m| s.contains(m)) {
        Error::Invalid("Couldn't download the Terraform provider plugins (the first run needs internet). Check your connection and try again.".into())
    } else {
        e
    }
}

// --- a lab's own module (cloud-services labs) ---------------------------------------------
//
// A cloud-services lab brings its own Terraform root module (`cloud.terraform` in its spec),
// used as is: it has no backend block pointing at the launcher's state, so the state is named
// with `-state` (the local backend's own option, as Isoloom's generated `up.sh` does), the
// plugins go under the state folder (TF_DATA_DIR), and the variables come from var files
// (the lab's fixed values, then the launch-time inputs) plus `TF_VAR_*` for the launcher's
// own (`expires_at`, `region`), which Terraform ignores when the module doesn't declare them.

/// Whether a folder is a Terraform module: it holds at least one `.tf` file.
pub fn is_module(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|d| d.flatten().any(|e| e.path().extension().is_some_and(|x| x == "tf")))
}

/// The arguments of a cloud-services `apply` or `destroy`: the state file, then the var files.
fn services_args(command: &str, state: &Path, var_files: &[std::path::PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = vec![command.into(), "-auto-approve".into(), "-input=false".into(), "-no-color".into()];
    args.push(format!("-state={}", state.join("terraform.tfstate").display()));
    args.extend(var_files.iter().map(|f| format!("-var-file={}", f.display())));
    args
}

async fn services_terraform(
    module: &Path,
    state: &Path,
    var_files: &[std::path::PathBuf],
    env: &[(String, String)],
    command: &str,
    mut log: impl FnMut(String),
) -> Result<()> {
    if !is_module(module) {
        return Err(Error::Invalid(format!("this lab has no Terraform module at {}", module.display())));
    }
    if run_read("terraform", &["version"], None).await.is_err() {
        return Err(Error::Invalid("Terraform isn't installed. Install it from the Machine page (Tools on this machine).".into()));
    }
    std::fs::create_dir_all(state)?;
    // Same reasoning as `terraform`: the launcher is this state's only writer, so a lock left now
    // is a stale one.
    let _ = std::fs::remove_file(state.join(".terraform.tfstate.lock.info"));
    let mut full = env.to_vec();
    full.push(("TF_DATA_DIR".to_string(), state.join(".terraform").display().to_string()));
    full.push(("TF_IN_AUTOMATION".to_string(), "1".to_string()));
    stream("terraform", &["init", "-input=false", "-no-color"], Some(module), &full, &mut log).await.map_err(init_error)?;
    let args = services_args(command, state, var_files);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    stream("terraform", &refs, Some(module), &full, log).await
}

/// The run record of a cloud-services deploy: when it ends (`expires_at`, for status and the
/// reaper) and the launcher variables a destroy passes again.
fn services_record(expires_at: Option<u64>, vars: &[(String, String)]) -> serde_json::Map<String, Value> {
    let mut run: serde_json::Map<String, Value> = vars.iter().filter(|(k, _)| k == "region").map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    if let Some(t) = expires_at {
        run.insert(EXPIRES_AT.into(), Value::from(t));
    }
    run.insert("cloud_services".into(), Value::Bool(true));
    run
}

/// The launcher variables of a destroy, from the run record: the same `region` and
/// `expires_at` the apply had (a module may require them even to destroy).
fn services_saved_vars(run_json: &str) -> Vec<(String, String)> {
    let mut vars = saved_vars(run_json);
    if let Ok(v) = serde_json::from_str::<Value>(run_json)
        && let Some(t) = v[EXPIRES_AT].as_u64()
    {
        vars.push(("expires_at".into(), t.to_string()));
    }
    vars.retain(|(k, _)| k == "region" || k == "expires_at");
    vars
}

/// Applies a lab's own module (see above). `vars` are the launcher's variables (`TF_VAR_*`),
/// `env` the cloud's credentials, `expires_at` when the lab auto-stops.
pub async fn apply_services(
    module: &Path,
    state: &Path,
    var_files: &[std::path::PathBuf],
    vars: &[(String, String)],
    expires_at: Option<u64>,
    env: &[(String, String)],
    log: impl FnMut(String),
) -> Result<()> {
    std::fs::create_dir_all(state)?;
    std::fs::write(state.join(RUN_FILE), serde_json::to_string(&services_record(expires_at, vars)).unwrap_or_default())?;
    services_terraform(module, state, var_files, &with_env(vars, env), "apply", log).await
}

/// Destroys what [`apply_services`] created, with the variables it recorded.
pub async fn destroy_services(
    module: &Path,
    state: &Path,
    var_files: &[std::path::PathBuf],
    env: &[(String, String)],
    mut log: impl FnMut(String),
) -> Result<()> {
    if !state.join("terraform.tfstate").is_file() {
        if state.join(RUN_FILE).is_file() {
            log("No Terraform state for this lab (it may have been reset). If resources were created, check your account and remove them there.".into());
        }
        return Ok(());
    }
    let vars = std::fs::read_to_string(state.join(RUN_FILE)).map(|raw| services_saved_vars(&raw)).unwrap_or_default();
    services_terraform(module, state, var_files, &with_env(&vars, env), "destroy", log).await?;
    let _ = std::fs::remove_file(state.join("terraform.tfstate"));
    Ok(())
}

/// The local state as JSON, when there is one.
pub fn state_json(state: &Path) -> Option<Value> {
    std::fs::read_to_string(state.join("terraform.tfstate")).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// Whether a state holds resources (anything that may bill).
pub fn has_resources(state: &Value) -> bool {
    state["resources"].as_array().is_some_and(|r| !r.is_empty())
}

/// Whether a state holds a failed resource (see `has_tainted`).
pub fn has_failed(state: &Value) -> bool {
    has_tainted(state)
}

/// When the lab of this state auto-stops (Unix seconds), from its run record.
pub fn expires_at(state: &Path) -> Option<u64> {
    std::fs::read_to_string(state.join(RUN_FILE)).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| v[EXPIRES_AT].as_u64())
}

/// Now, in Unix seconds.
pub fn unix_now() -> u64 {
    now()
}

/// Creates (or updates) the target's resources. `vars` are Terraform variable names;
/// `env` is raw environment the provider reads itself (cloud credentials).
pub async fn apply(module: &Path, state: &Path, vars: &[(String, String)], env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    std::fs::create_dir_all(state)?;
    // Remember the non-secret variables, so a later destroy has them without the launch spec.
    let run = run_record(vars, now());
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
    let Some(target) = ssh::launcher_key().and_then(|identity| ssh_target(state, identity)) else {
        log("Can't reach the lab host over SSH to confirm it started; check it from the lab page.".into());
        return Ok(());
    };
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
    let mut log = log;
    if !state.join("terraform.tfstate").is_file() {
        // A recorded deploy whose state is gone (e.g. the app data was wiped): there's nothing to
        // destroy from here, but resources may still exist on the account. Say so rather than
        // reporting a clean stop.
        if state.join(RUN_FILE).is_file() {
            log("No Terraform state for this lab (it may have been reset). If resources were created, check your account and remove them there.".into());
        }
        return Ok(());
    }
    let mut all: Vec<(String, String)> = vars.to_vec();
    if let Ok(raw) = std::fs::read_to_string(state.join(RUN_FILE)) {
        all.extend(saved_vars(&raw));
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
    // Drop the per-deployment known_hosts too: the next lab can get a recycled host IP with a
    // new host key, and a stale pinned key would make its SSH (wait_ready, attack shell) fail.
    let _ = std::fs::remove_file(state.join("known_hosts"));
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
/// Where the node login for a lab reached through its Proxmox node is kept (`user@host`).
pub const JUMP_FILE: &str = "ssh-jump";

/// The lab host as an SSH target with the launcher's key, through the node when the launch
/// recorded one (see JUMP_FILE).
pub fn ssh_target(state: &Path, identity: std::path::PathBuf) -> Option<ssh::Target> {
    let (host, user) = ssh_endpoint(state)?;
    let jump = std::fs::read_to_string(state.join(JUMP_FILE)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Some(ssh::Target { host, port: 22, user, identity, jump })
}

pub fn ssh_endpoint(state: &Path) -> Option<(String, String)> {
    let raw = std::fs::read_to_string(state.join("terraform.tfstate")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let ip = v["outputs"]["ip"]["value"].as_str().filter(|s| !s.is_empty())?.to_string();
    let user = v["outputs"]["ssh_user"]["value"].as_str().unwrap_or("isoloom").to_string();
    Some((ip, user))
}

/// Status from the local state's outputs (no container run, so it's cheap to poll).
pub fn status(state: &Path) -> LabStatus {
    let tfstate = std::fs::read_to_string(state.join("terraform.tfstate")).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let outputs = tfstate.as_ref().map(|v| v["outputs"].clone()).unwrap_or(Value::Null);
    // A step that failed (the lab's setup on the VM) leaves its resource tainted: the VM exists
    // but the lab never came up, so it is not running; its machine stays listed as left behind.
    let failed = tfstate.as_ref().is_some_and(has_tainted);
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
            infra: false,
        }]
    } else {
        Vec::new()
    };
    LabStatus {
        running: created && !failed,
        parked: None,
        machines,
        networks: Vec::new(),
        url: None,
        host: None,
        expires_at: expires_at.filter(|_| created),
        place: None,
        provider: None,
        outputs: Vec::new(),
        message: None,
    }
}

/// The state holds a lab host: Isoloom modules output its `ip`.
fn has_instance(outputs: &Value) -> bool {
    outputs["ip"]["value"].as_str().is_some_and(|ip| !ip.is_empty())
}

/// True when the state still holds a cloud instance whose auto-stop time has passed, so it
/// needs a `destroy` to free the resources and end billing (an OS poweroff does not deallocate
/// on Azure). Unlike `status`, this stays true after expiry; it's the signal the reaper uses.
pub fn expired(state: &Path) -> bool {
    let json = std::fs::read_to_string(state.join("terraform.tfstate")).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    // A completed apply exposes the lab host's `ip`; an interrupted or crashed apply may have
    // already created billable resources without ever writing that output. Reap on either, so a
    // half-done cloud deploy can't keep billing silently.
    let has_billable = json.as_ref().is_some_and(|j| has_instance(&j["outputs"]) || j["resources"].as_array().is_some_and(|r| !r.is_empty()));
    let expires_at =
        std::fs::read_to_string(state.join(RUN_FILE)).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| v[EXPIRES_AT].as_u64());
    has_billable && expires_at.is_some_and(|t| now() >= t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tainted_setup_is_not_running() {
        let ok = serde_json::json!({"resources": [{"instances": [{"status": null}]}]});
        let failed = serde_json::json!({"resources": [{"instances": [{}]}, {"instances": [{"status": "tainted"}]}]});
        assert!(!has_tainted(&ok));
        assert!(has_tainted(&failed));
        assert!(!has_tainted(&serde_json::json!({})));
    }

    #[test]
    fn container_mounts_the_whole_lab() {
        assert_eq!(lab_root(Path::new("/d/labs/x/.isoloom-1/docker-vm/proxmox")), Path::new("/d/labs/x"));
        assert_eq!(lab_root(Path::new("/d/labs/x/.isoloom/proxmox")), Path::new("/d/labs/x"));
        assert_eq!(lab_root(Path::new("/tmp/selftest/terraform/proxmox")), Path::new("/tmp/selftest/terraform/proxmox"));
    }

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
    fn run_record_keeps_only_connection_vars_and_expiry() {
        let vars = vec![
            ("ssh_public_key".to_string(), "ssh-ed25519 AAAA".to_string()),
            ("ssh_private_key_file".to_string(), "/k/id".to_string()),
            ("allowed_cidr".to_string(), "1.2.3.0/24".to_string()),
            ("proxmox_password".to_string(), "secret".to_string()),
            ("region".to_string(), "eu-west-3".to_string()),
            ("auto_stop_hours".to_string(), "4".to_string()),
        ];
        let run = run_record(&vars, 1_000);
        // Secrets and lab-specific vars are not persisted; the connection keys are.
        assert_eq!(run.get("ssh_public_key").and_then(|v| v.as_str()), Some("ssh-ed25519 AAAA"));
        assert_eq!(run.get("ssh_private_key_file").and_then(|v| v.as_str()), Some("/k/id"));
        assert_eq!(run.get("allowed_cidr").and_then(|v| v.as_str()), Some("1.2.3.0/24"));
        assert!(run.get("proxmox_password").is_none());
        assert!(run.get("region").is_none());
        // 4 hours past the given `now`.
        assert_eq!(run.get(EXPIRES_AT).and_then(|v| v.as_u64()), Some(1_000 + 4 * 3600));
    }

    #[test]
    fn run_record_omits_expiry_when_auto_stop_absent_or_zero() {
        assert!(run_record(&[], 1_000).get(EXPIRES_AT).is_none());
        let zero = vec![("auto_stop_hours".to_string(), "0".to_string())];
        assert!(run_record(&zero, 1_000).get(EXPIRES_AT).is_none());
    }

    #[test]
    fn saved_vars_round_trips_connection_vars_and_skips_numbers() {
        let vars = vec![
            ("ssh_public_key".to_string(), "ssh-ed25519 AAAA".to_string()),
            ("allowed_cidr".to_string(), "1.2.3.0/24".to_string()),
            ("auto_stop_hours".to_string(), "4".to_string()),
        ];
        let json = serde_json::to_string(&run_record(&vars, 1_000)).unwrap();
        let mut restored = saved_vars(&json);
        restored.sort();
        // expires_at is a number and is not restored as a variable.
        assert_eq!(restored, vec![("allowed_cidr".to_string(), "1.2.3.0/24".to_string()), ("ssh_public_key".to_string(), "ssh-ed25519 AAAA".to_string())]);
    }

    #[test]
    fn saved_vars_tolerates_garbage_and_non_objects() {
        assert!(saved_vars("").is_empty());
        assert!(saved_vars("not json").is_empty());
        assert!(saved_vars("[1,2,3]").is_empty());
        assert!(saved_vars(r#"{"expires_at":123}"#).is_empty());
    }

    #[test]
    fn has_instance_needs_a_nonempty_ip_output() {
        assert!(has_instance(&serde_json::json!({"ip": {"value": "10.0.0.9"}})));
        // State with resources but no ip output (or an empty one) is not a live instance.
        assert!(!has_instance(&serde_json::json!({"ip": {"value": ""}})));
        assert!(!has_instance(&serde_json::json!({"other": {"value": "x"}})));
        assert!(!has_instance(&Value::Null));
    }

    #[test]
    fn output_reads_nonempty_string_values_only() {
        let dir = std::env::temp_dir().join(format!("cyberctf-tf-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        // No state file yet.
        assert_eq!(output(&dir, "ip"), None);
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{"ip":{"value":"10.0.0.9"},"empty":{"value":""},"ready_file":{"value":"/run/ready"}}}"#)
            .unwrap();
        assert_eq!(output(&dir, "ip").as_deref(), Some("10.0.0.9"));
        assert_eq!(output(&dir, "ready_file").as_deref(), Some("/run/ready"));
        assert_eq!(output(&dir, "empty"), None);
        assert_eq!(output(&dir, "missing"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ssh_endpoint_defaults_the_user_and_needs_an_ip() {
        let dir = std::env::temp_dir().join(format!("cyberctf-tf-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(ssh_endpoint(&dir), None);
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{"ip":{"value":"10.0.0.9"}}}"#).unwrap();
        assert_eq!(ssh_endpoint(&dir), Some(("10.0.0.9".to_string(), "isoloom".to_string())));
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{"ip":{"value":"10.0.0.9"},"ssh_user":{"value":"ubuntu"}}}"#).unwrap();
        assert_eq!(ssh_endpoint(&dir), Some(("10.0.0.9".to_string(), "ubuntu".to_string())));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expired_is_true_only_with_an_instance_past_its_stop_time() {
        let dir = std::env::temp_dir().join(format!("cyberctf-tf-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        // No state: not expired.
        assert!(!expired(&dir));
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{"ip":{"value":"10.0.0.9"}}}"#).unwrap();
        // Instance but no run.json (no auto-stop): never expires.
        assert!(!expired(&dir));
        // Future stop time: not expired yet (unlike status, which also shows it running).
        std::fs::write(dir.join(RUN_FILE), format!(r#"{{"expires_at":{}}}"#, now() + 3600)).unwrap();
        assert!(!expired(&dir));
        // Past stop time: expired, so the reaper destroys it.
        std::fs::write(dir.join(RUN_FILE), r#"{"expires_at":1}"#).unwrap();
        assert!(expired(&dir));
        // Expiry past but the instance is already gone (no ip): nothing to reap.
        std::fs::write(dir.join("terraform.tfstate"), r#"{"outputs":{}}"#).unwrap();
        assert!(!expired(&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_labs_own_module_runs_on_the_launchers_state_and_var_files() {
        let state = Path::new("/d/deployments/goat/aws");
        let files = vec![std::path::PathBuf::from("/d/labs/goat/.isoloom/cloud-services/terraform.tfvars.json"), state.join("inputs.tfvars.json")];
        assert_eq!(
            services_args("apply", state, &files),
            [
                "apply",
                "-auto-approve",
                "-input=false",
                "-no-color",
                "-state=/d/deployments/goat/aws/terraform.tfstate",
                "-var-file=/d/labs/goat/.isoloom/cloud-services/terraform.tfvars.json",
                "-var-file=/d/deployments/goat/aws/inputs.tfvars.json",
            ]
        );
        assert_eq!(services_args("destroy", state, &[])[0], "destroy");
    }

    #[test]
    fn a_cloud_services_record_replays_region_and_expiry_on_destroy() {
        let vars = vec![("region".to_string(), "eu-west-3".to_string()), ("expires_at".to_string(), "5000".to_string())];
        let run = services_record(Some(5000), &vars);
        assert_eq!(run.get(EXPIRES_AT).and_then(Value::as_u64), Some(5000));
        assert_eq!(run.get("region").and_then(Value::as_str), Some("eu-west-3"));
        let json = serde_json::to_string(&run).unwrap();
        let mut back = services_saved_vars(&json);
        back.sort();
        assert_eq!(back, vec![("expires_at".to_string(), "5000".to_string()), ("region".to_string(), "eu-west-3".to_string())]);
        // No auto-stop: no expiry recorded nor replayed.
        let json = serde_json::to_string(&services_record(None, &[])).unwrap();
        assert!(services_saved_vars(&json).is_empty());
        assert!(services_saved_vars("garbage").is_empty());
    }

    /// A lab's own module through apply and destroy with the host Terraform, no cloud: a module of
    /// `terraform_data` only (built in, nothing to download). Opt-in (needs `terraform`):
    ///   cargo test services_apply_and_destroy_locally -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn services_apply_and_destroy_locally() {
        let root = std::env::temp_dir().join(format!("cyberctf-tf-svc-{}", rand::random::<u32>()));
        let (module, state) = (root.join("lab/terraform"), root.join("deployments/lab/aws"));
        std::fs::create_dir_all(&module).unwrap();
        std::fs::write(
            module.join("main.tf"),
            "variable \"expires_at\" {}\nvariable \"whitelist\" {}\nvariable \"size\" {}\nresource \"terraform_data\" \"svc\" { input = \"${var.whitelist}:${var.size}:${var.expires_at}\" }\noutput \"svc\" { value = terraform_data.svc.output }\noutput \"key\" {\n  value     = \"s3cr3t\"\n  sensitive = true\n}\n",
        )
        .unwrap();
        let fixed = root.join("lab/terraform.tfvars.json");
        std::fs::write(&fixed, r#"{"size": 2}"#).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("inputs.tfvars.json"), r#"{"whitelist": "203.0.113.7/32"}"#).unwrap();
        let files = vec![fixed, state.join("inputs.tfvars.json")];
        // `region` isn't declared by the module: as TF_VAR_ it is ignored, not an error.
        let vars = vec![("expires_at".to_string(), "4102444800".to_string()), ("region".to_string(), "eu-west-3".to_string())];
        let print = |l: String| println!("{l}");
        apply_services(&module, &state, &files, &vars, Some(4_102_444_800), &[], print).await.expect("apply");
        let s = state_json(&state).expect("state beside the launcher's other deployments");
        assert!(has_resources(&s) && !has_failed(&s));
        assert_eq!(s["outputs"]["svc"]["value"], "203.0.113.7/32:2:4102444800");
        assert_eq!(s["outputs"]["key"]["sensitive"], true);
        assert_eq!(expires_at(&state), Some(4_102_444_800));
        // Nothing written into the module but Terraform's lock file.
        assert!(!module.join("terraform.tfstate").exists());
        destroy_services(&module, &state, &files, &[], print).await.expect("destroy");
        assert!(state_json(&state).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_module_is_a_folder_with_tf_files() {
        let dir = std::env::temp_dir().join(format!("cyberctf-tf-mod-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_module(&dir));
        assert!(!is_module(&dir.join("missing")));
        // AWSGoat's root module has no main.tf, only other .tf files.
        std::fs::write(dir.join("providers.tf"), "").unwrap();
        assert!(is_module(&dir));
        std::fs::remove_dir_all(dir).unwrap();
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
