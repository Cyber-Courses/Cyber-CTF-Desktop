//! Starting a lab: on this machine (local Docker, a container lab in one local VM, or one VM per
//! machine), or on a server host (ESXi through Vagrant, Proxmox and the clouds through Terraform).

use std::path::Path;

use tauri::AppHandle;

use super::inflight::{Action, DeployGuard, lock_lab};
use super::lifecycle::resume_locked;
use super::paths::{local_vm, mark_local_vm, mark_parked, parked, record_runtime, state_dir, vagrant_dirs};
use super::providers::Provider;
use super::{Runtime, attack_box, attack_vm, docker, exegol, lab, registry, server, ssh, terraform, vm};
use crate::error::{Error, Result};

/// Starts an installed lab; `env` is passed to the runtime (evidence claim, attack box).
///
/// - No `host`: Docker labs run on this machine's Docker, or in one VM on this machine with a
///   local `provider` (Isoloom's docker-vm); VM labs run one VM per machine (Isoloom's vagrant).
/// - With a server `host`: the lab runs there. ESXi runs the same Vagrantfiles; Proxmox and
///   the clouds run Isoloom's Terraform (Docker on one VM, or one VM per machine on Proxmox).
#[allow(clippy::too_many_arguments)]
pub async fn start(
    app: &AppHandle,
    dir: &Path,
    id: &str,
    runtime: Runtime,
    provider: Option<Provider>,
    host: Option<&str>,
    env: &[(String, String)],
    mut log: impl FnMut(String),
) -> Result<()> {
    let _lock = lock_lab(id).await;
    let _deploy = DeployGuard::new(id, Action::Start);
    match host {
        None => start_here(app, dir, id, runtime, provider, env, &mut log).await,
        Some(host) => start_on_server(app, dir, id, runtime, host, env, &mut log).await,
    }
}

async fn start_here(
    app: &AppHandle,
    dir: &Path,
    id: &str,
    runtime: Runtime,
    provider: Option<Provider>,
    env: &[(String, String)],
    log: &mut impl FnMut(String),
) -> Result<()> {
    server::mark_lab(dir, None)?;
    // A parked lab (paused or shut down) is one the player wants back as it was, not rebuilt:
    // its stopped machines would otherwise read as leftovers and be cleared below.
    // Unless nothing of it is left to resume: a parked container lab whose stopped containers
    // were pruned (or Docker reset) can only start fresh, and resuming would fail every time.
    if parked(dir).is_some() && runtime == Runtime::Docker && local_vm(dir).is_none() && docker::containers(dir, id).await.is_ok_and(|n| n == 0) {
        log("This lab was shut down here, but its stopped containers are gone: starting it fresh.".into());
        mark_parked(dir, None)?;
    }
    if parked(dir).is_some() {
        log("This lab is parked on this machine: resuming it as it was. Stop it first if you want a fresh copy.".into());
        return resume_locked(app, dir, id, runtime, log).await;
    }
    // A lab runs in one place at a time: if it's already up here, refuse (a second copy
    // collides on its published host ports); if an earlier start left stopped or partial
    // infrastructure behind, clear it so this start is clean.
    ensure_local_slot_free(dir, id, log).await?;
    match runtime {
        // A container lab in a VM on this machine: Isoloom's docker-vm (Docker on one VM), with
        // the attack box next to it inside the VM (the lab network isn't reachable from here).
        Runtime::Docker if let Some(provider) = provider.filter(|p| !p.is_remote()) => {
            let spec = lab::prepare(dir, lab::vagrant_target(runtime))?;
            mark_local_vm(dir, Some(provider))?;
            log(format!("Running in a {} VM on this machine", provider.id()));
            let vagrant = lab::vagrant_dir(dir, runtime);
            start_local_vm(&vagrant, provider, env, log).await?;
            attack_box::in_lab_vm_or_note(&vagrant, &spec, env, log).await;
            finish_vagrant(dir, &spec, runtime, log);
            Ok(())
        }
        Runtime::Docker => start_on_docker(dir, id, env, log).await,
        Runtime::Vm => {
            let provider = provider.ok_or_else(|| Error::Invalid("VM labs need a provider".into()))?;
            if provider.is_remote() {
                return Err(Error::Invalid("pick a server host to run on ESXi or Proxmox".into()));
            }
            let spec = lab::prepare(dir, lab::vagrant_target(runtime))?;
            warn_if_low_memory(&spec, log);
            if provider == Provider::Qemu {
                check_qemu(&spec, log).await?;
            }
            let vagrant = lab::vagrant_dir(dir, runtime);
            start_local_vm(&vagrant, provider, env, log).await?;
            finish_vagrant(dir, &spec, runtime, log);
            // The lab's networks are internal to the hypervisor, so the learner's attack VM
            // (their own box, chosen in Settings) goes beside it, on the same hypervisor. The
            // lab is up at this point: a failing attacker is noted, not a failed deploy.
            if let Some(b) = attack_box::attack_vm_box(env)
                && let Err(e) = attack_vm::start(dir, &vagrant, provider, b, &mut *log).await
            {
                log(format!("The lab is running, but its attack VM didn't start: {e}. Start it from the lab page to retry."));
            }
            Ok(())
        }
    }
}

/// A container lab on this machine's Docker: generate its Compose project, bring it up, plug a
/// running attack box back into its networks, and record it for Isoloom. Takes the lab folder
/// (no app handle), so the real-lab tests run exactly this.
pub(super) async fn start_on_docker(dir: &Path, id: &str, env: &[(String, String)], log: &mut impl FnMut(String)) -> Result<()> {
    let spec = lab::prepare(dir, isoloom_core::Target::Docker)?;
    mark_local_vm(dir, None)?;
    docker::start(dir, id, env, &mut *log).await?;
    exegol::rejoin(id).await;
    registry::record_docker(dir, &spec, docker::project(id));
    // Its ports here are the ones picked at its first start, not the spec's.
    let published = docker::published(dir, id, env).await;
    if let Some(m) = lab::message_at(dir, &spec, isoloom_core::Target::Docker, &published) {
        log_lines(&m, log);
    }
    Ok(())
}

async fn start_on_server(
    app: &AppHandle,
    dir: &Path,
    id: &str,
    runtime: Runtime,
    host: &str,
    env: &[(String, String)],
    log: &mut impl FnMut(String),
) -> Result<()> {
    // GCP labs run in the account's labs project: make sure it exists (one free billing slot).
    if server::connection(app, host)?.provider == Provider::Gcp {
        log("Checking the Cyber CTF labs project on Google Cloud…".into());
        server::gcp::labs_project(app, host).await?;
    }
    let conn = server::connection(app, host)?;
    // Mark first, so a half-created lab can still be destroyed on the same host.
    server::mark_lab(dir, Some(host))?;
    log(format!("Running on server host {} ({})", conn.name, conn.provider.id()));
    match server::terraform_target(conn.provider) {
        Some(tf) => start_terraform(app, dir, id, runtime, host, tf, conn, env, log).await,
        // ESXi: the same Vagrantfiles as on this machine, with the vmware_esxi provider.
        None => {
            let spec = lab::prepare(dir, lab::vagrant_target(runtime))?;
            let env: Vec<(String, String)> = env.iter().cloned().chain(conn.env).collect();
            let vagrant = lab::vagrant_dir(dir, runtime);
            // Switched here from a local (or other) provider: clear the stale state first, so the
            // ESXi start doesn't refuse with "an active machine was found with a different provider".
            vm::reconcile_provider(&vagrant, conn.provider, &env, log).await;
            vm::start(&vagrant, conn.provider, &env, &mut *log).await?;
            if runtime == Runtime::Docker {
                attack_box::in_lab_vm_or_note(&vagrant, &spec, &env, log).await;
            }
            finish_vagrant(dir, &spec, runtime, log);
            Ok(())
        }
    }
}

/// Proxmox and the clouds: Isoloom's Terraform for the lab's target, applied with the host's
/// variables, the launcher's SSH key and (on a cloud) a firewall locked to this machine.
#[allow(clippy::too_many_arguments)]
async fn start_terraform(
    app: &AppHandle,
    dir: &Path,
    id: &str,
    runtime: Runtime,
    host: &str,
    tf: &'static str,
    conn: server::Connection,
    env: &[(String, String)],
    log: &mut impl FnMut(String),
) -> Result<()> {
    let provider = conn.provider;
    let (module, target) = lab::terraform(dir, runtime, tf)?;
    let spec = lab::prepare(dir, target)?;
    let mut vars = conn.tf_vars.clone();
    if let Some(inputs) = lab::inputs_json(&spec, env) {
        vars.push(("inputs".into(), inputs));
    }
    // The launcher's key: Terraform copies the lab over SSH with it, and "Open shell"
    // reaches the attack box on the lab host.
    let (key, public) = ssh::ensure_key(app).await?;
    // A Proxmox lab bridge this machine can't route to: Terraform and the launcher reach
    // the VM through the node.
    let jump = server::proxmox_jump(app, dir, &key, &public).await?;
    if jump.is_some() {
        log("The lab bridge is internal to the node: reaching the lab VM through the node.".into());
        vars.push(("ssh_via_node".into(), "true".into()));
    }
    vars.push(("ssh_public_key".into(), public));
    vars.push(("ssh_private_key_file".into(), key.to_string_lossy().to_string()));
    if provider.is_cloud() {
        // Every cloud firewall opens SSH and the published ports to this machine's
        // public IP only.
        vars.push(("allowed_cidr".into(), format!("{}/32", public_ip().await?)));
    }
    if provider == Provider::Aws {
        check_aws_budget(app, host, log).await?;
    }
    if provider.is_cloud() {
        log(format!("This lab runs in your {} account and is billed there until you stop it.", provider.id().to_uppercase()));
    }
    let state = state_dir(app, id, tf)?;
    std::fs::create_dir_all(&state)?;
    // Which output ran (containers or one VM per machine), for the auto-stop reaper.
    record_runtime(&state, runtime)?;
    match &jump {
        Some(login) => std::fs::write(state.join(terraform::JUMP_FILE), login)?,
        None => {
            let _ = std::fs::remove_file(state.join(terraform::JUMP_FILE));
        }
    }
    terraform::apply(&module, &state, &vars, &conn.tf_env, &mut *log).await?;
    if runtime == Runtime::Docker {
        attack_box::on_terraform_host(app, id, &spec, env, log).await?;
    }
    registry::record(dir, &spec, target, provider.is_cloud().then_some(tf));
    welcome(dir, &spec, lab::vagrant_target(runtime), log);
    Ok(())
}

/// Stops before spending if this AWS account is over its monthly budget, or if a budget is set
/// and the spend is over it; if the spend can't be read, warns and lets the launch go on.
async fn check_aws_budget(app: &AppHandle, host: &str, log: &mut impl FnMut(String)) -> Result<()> {
    match server::check_budget(app, host).await {
        server::BudgetCheck::Over(spent, limit) => Err(Error::Invalid(format!(
            "Monthly budget reached for this account: ${spent:.2} of ${limit:.2} spent this month. Raise the budget in the account settings, or wait until next month."
        ))),
        // Best effort: if the spend can't be read (Cost Explorer off, expired session,
        // Docker/CLI missing), note it and launch anyway. The lab still auto-stops, so
        // cost is bounded; blocking every launch over this would be too aggressive.
        server::BudgetCheck::Unverifiable(why) => {
            log(format!("Monthly budget not checked: {why} Launching anyway; the lab still auto-stops."));
            Ok(())
        }
        server::BudgetCheck::Ok => Ok(()),
    }
}

/// The end of a Vagrant start (local or ESXi): the lab recorded, and its welcome message.
fn finish_vagrant(dir: &Path, spec: &isoloom_core::Spec, runtime: Runtime, log: &mut impl FnMut(String)) {
    registry::record(dir, spec, lab::vagrant_target(runtime), None);
    welcome(dir, spec, lab::vagrant_target(runtime), log);
}

/// The lab's own words once it is up (`message:` in its spec, addresses filled in): where to
/// start and what to do first, as the last lines of the deploy log.
fn welcome(dir: &Path, spec: &isoloom_core::Spec, target: isoloom_core::Target, log: &mut impl FnMut(String)) {
    if let Some(m) = lab::message(dir, spec, target) {
        log_lines(&m, log);
    }
}

fn log_lines(text: &str, log: &mut impl FnMut(String)) {
    text.lines().for_each(|l| log(l.to_string()));
}

/// Guards a local start: refuses when the lab is already running on this machine (Docker or a
/// local VM), and otherwise tears down any stopped or half-created leftovers from a previous
/// start so the fresh start doesn't trip over them (a poweroff VM, dead containers).
async fn ensure_local_slot_free(dir: &Path, id: &str, log: &mut impl FnMut(String)) -> Result<()> {
    // Docker containers of this lab on this machine (best effort: before the first start the
    // compose file may not exist yet, and status then errors, which just means nothing to clear).
    if let Ok(s) = docker::status(dir, id).await {
        if s.running {
            return Err(Error::Invalid("This lab is already running on this machine. Stop it before starting it again.".into()));
        }
        if docker::containers(dir, id).await.is_ok_and(|n| n > 0) {
            log("Clearing a previous, stopped run…".into());
            let _ = docker::stop(dir, id, |_l: String| {}).await;
        }
    }
    // A local VM for this lab (Docker on one VM, or a VM lab), whichever vagrant folder holds one.
    for vdir in vagrant_dirs(dir) {
        let Ok(s) = vm::status(&vdir, &[]).await else { continue };
        if s.running {
            return Err(Error::Invalid("This lab is already running in a VM on this machine. Stop it before starting it again.".into()));
        }
        // "not_created" is a clean slate; anything else (poweroff, aborted, saved) is a leftover.
        if s.machines.iter().any(|m| m.state != "not_created") {
            log("Clearing a previous, incomplete VM…".into());
            let _ = vm::stop(&vdir, &[], |_l: String| {}).await;
        }
    }
    Ok(())
}

/// Warns (without blocking) when the host likely can't fit all of a one-VM-per-machine lab's
/// memory, so an out-of-memory failure mid-boot isn't a surprise. Not used for a container lab
/// in a single VM, where the total would overcount.
fn warn_if_low_memory(spec: &isoloom_core::Spec, log: &mut impl FnMut(String)) {
    use sysinfo::System;
    let needed_mb = u64::from(isoloom_core::totals(spec).memory_mb);
    let mut sys = System::new();
    sys.refresh_memory();
    let available_mb = sys.available_memory() / (1024 * 1024);
    if available_mb > 0 && needed_mb > available_mb {
        log(format!(
            "This lab's VMs ask for about {needed_mb} MB, but only ~{available_mb} MB is free on this machine. It may run slowly or fail to boot; close other apps or stop other labs if it struggles."
        ));
    }
}

/// The CPUs (`std::env::consts::ARCH` names) a lab's VMs are built for that differ from `host`,
/// i.e. the ones QEMU has to emulate.
fn emulated_arches(spec: &isoloom_core::Spec, host: &str) -> Vec<&'static str> {
    let mut emulated: Vec<&'static str> = spec
        .machines
        .values()
        .filter(|m| m.vm.is_some())
        .map(|m| match m.arch {
            isoloom_core::Arch::Amd64 => "x86_64",
            isoloom_core::Arch::Arm64 => "aarch64",
        })
        .filter(|a| *a != host)
        .collect();
    emulated.dedup();
    emulated
}

/// A lab on QEMU: its networks must fit QEMU's two-VM links, and a machine built for another CPU
/// needs that CPU's emulator (`qemu-system-x86_64` for an x86 lab on an Apple Silicon Mac).
async fn check_qemu(spec: &isoloom_core::Spec, log: &mut impl FnMut(String)) -> Result<()> {
    if let Some(why) = isoloom_core::qemu_refusal(spec) {
        return Err(Error::Invalid(format!("This lab can't run on QEMU yet: {why}. Run it on a server or in your cloud account.")));
    }
    let host = std::env::consts::ARCH;
    for arch in emulated_arches(spec, host) {
        let bin = if arch == "x86_64" { "qemu-system-x86_64" } else { "qemu-system-aarch64" };
        if crate::exec::run(bin, &["--version"], None).await.is_err() {
            return Err(Error::Invalid(format!(
                "This lab's machines are {arch}, and QEMU's {arch} emulator ({bin}) isn't installed. Reinstall QEMU from the Machine page."
            )));
        }
        log(format!(
            "Emulating {arch} on this {host} machine with QEMU, many times slower than native: a Windows machine takes 15 to 40 minutes to boot, and the lab's setup can take hours."
        ));
    }
    Ok(())
}

/// Starts local VMs with one automatic recovery. A `vagrant up` can fail because a crashed or
/// interrupted previous run left state behind that `ensure_local_slot_free` couldn't see: an
/// orphaned hypervisor VM (VirtualBox "VERR_ALREADY_EXISTS") or a stale lock ("the machine is
/// locked"). When the failure is one of those, clear the leftovers and try once more; a genuine
/// provisioning failure is returned unchanged, never retried.
async fn start_local_vm(dir: &Path, provider: Provider, env: &[(String, String)], log: &mut impl FnMut(String)) -> Result<()> {
    // A missing hypervisor or Vagrant plugin should say so plainly, not fail mid-boot with a
    // raw Vagrant error.
    super::providers::ensure_usable(provider).await.map_err(Error::Invalid)?;
    // Switched target since last time (e.g. an ESXi run, now local): clear the old state so
    // `vagrant up` doesn't refuse with "an active machine was found with a different provider".
    vm::reconcile_provider(dir, provider, env, log).await;
    let mut stale = false;
    let first = vm::start(dir, provider, env, |l: String| {
        stale |= vm::is_stale_state_error(&l);
        log(l);
    })
    .await;
    match first {
        Ok(()) => Ok(()),
        Err(_) if stale => {
            log("A previous run left VM state behind. Clearing it, then starting again…".into());
            vm::recover_local(dir, provider, log).await;
            vm::start(dir, provider, env, log).await
        }
        Err(e) => Err(e),
    }
}

/// This machine's public IPv4, for cloud firewall rules.
async fn public_ip() -> Result<String> {
    // Several resolvers, tried in turn: this is a hard dependency of every cloud launch (the
    // firewall is locked to this machine's IP), so one endpoint being down or blocked must not
    // fail the launch. Each has its own short timeout so a hanging endpoint doesn't stall it.
    const RESOLVERS: [&str; 4] = ["https://checkip.amazonaws.com", "https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"];
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|e| Error::Invalid(e.to_string()))?;
    let mut last = String::new();
    for url in RESOLVERS {
        match client.get(url).send().await.and_then(|r| r.error_for_status()) {
            Ok(resp) => match resp.text().await {
                Ok(body) if let Some(ip) = parse_ipv4(&body) => return Ok(ip),
                Ok(_) => last = format!("{url} gave an unexpected answer"),
                Err(e) => last = format!("{url}: {e}"),
            },
            Err(e) => last = format!("{url}: {e}"),
        }
    }
    Err(Error::Invalid(format!(
        "Couldn't determine your public IP, needed to allow only your machine through the lab's firewall. Check your internet connection and try again. ({last})"
    )))
}

/// A resolver's answer as an IPv4 address, surrounding whitespace ignored.
fn parse_ipv4(body: &str) -> Option<String> {
    let ip = body.trim();
    ip.parse::<std::net::Ipv4Addr>().is_ok().then(|| ip.to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_ipv4, start_on_docker};

    #[tokio::test]
    async fn a_docker_start_without_a_lab_spec_fails_before_touching_docker() {
        let dir = std::env::temp_dir().join(format!("cyberctf-nolab-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut logged = Vec::new();
        let res = start_on_docker(&dir, "no-lab", &[], &mut |l| logged.push(l)).await;
        // Nothing generated, no marker written, nothing run.
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(res.is_err());
        assert!(logged.is_empty(), "{logged:?}");
        assert!(left.is_empty());
    }

    #[test]
    fn resolver_answers_must_be_one_ipv4() {
        assert_eq!(parse_ipv4("203.0.113.7\n").as_deref(), Some("203.0.113.7"));
        assert_eq!(parse_ipv4("  198.51.100.1 ").as_deref(), Some("198.51.100.1"));
        assert_eq!(parse_ipv4("2001:db8::1"), None);
        assert_eq!(parse_ipv4("<html>blocked</html>"), None);
        assert_eq!(parse_ipv4(""), None);
    }
}
