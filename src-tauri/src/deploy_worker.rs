//! Lab operations that outlive the app. A launch, a resume, a pause or shutdown, a provisioning
//! run and an attack VM start each run in a detached worker process: this same executable,
//! headless (`cyberctf-desktop deploy --job <file>`), in its own process group, with its output
//! in a log file. Quitting, crashing or rebuilding the app never cuts a `vagrant up`, a `compose
//! up` or a `terraform apply` short. The app only follows the worker's log; "in progress" is a
//! live pidfile, so a relaunched app sees the operation and re-attaches to its log.
//!
//! Files, under `<app data>/deploys/`, keyed by the lab (`<lab>`) or, for its attack VM, which
//! runs beside the lab's own operation, `<lab>.attack`: `<key>.json` (the job), `<key>.log`
//! (what the worker says, also its stdout/stderr), `<key>.pid` (the worker, while it runs),
//! `<key>.status` (`ok` or `error: ...`, written last).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::runtime::providers::Provider;
use crate::runtime::{Park, Runtime};

/// What a worker runs. `Launch` (the default, so job files from before the other kinds existed
/// still read) is a full deploy from a `startLab` payload; the others act on an installed lab.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    #[default]
    Launch,
    /// Bring a parked (or partly down) lab back as it was.
    Resume { runtime: Runtime },
    /// Pause or shut the lab down, machines kept.
    Park { runtime: Runtime, mode: Park },
    /// Run the provisioners again on one machine (or all).
    Provision { runtime: Runtime, machine: Option<String> },
    /// Start the attack VM beside a VM lab.
    AttackVm { box_name: String },
}

/// What a worker needs: the lab, the operation, and for a launch the `startLab` payload and
/// where/how to run it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Job {
    pub lab_id: String,
    /// Absent in job files from before operations existed: a launch.
    #[serde(default)]
    pub op: Op,
    /// The `startLab` payload (`{ labId, runtime, repository, commit, env }`); null for the
    /// operations on an installed lab.
    #[serde(default)]
    pub launch: serde_json::Value,
    #[serde(default)]
    pub provider: Option<Provider>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub attackbox_image: Option<String>,
}

impl Job {
    /// An operation on an installed lab (no launch payload).
    pub fn on_lab(lab_id: &str, op: Op) -> Job {
        Job { lab_id: lab_id.to_string(), op, launch: serde_json::Value::Null, provider: None, host: None, attackbox_image: None }
    }

    /// The worker files' key: the lab's own operations share one (they are serialised by the
    /// lab lock anyway); the attack VM runs beside them under its own.
    pub fn key(&self) -> String {
        match self.op {
            Op::AttackVm { .. } => attack_key(&self.lab_id),
            _ => self.lab_id.clone(),
        }
    }

    /// What this operation is, for the "another one is in progress" message.
    fn what(&self) -> &'static str {
        match self.op {
            Op::Launch => "a start",
            Op::Resume { .. } => "a resume",
            Op::Park { .. } => "a pause or shutdown",
            Op::Provision { .. } => "a provisioning run",
            Op::AttackVm { .. } => "an attack VM start",
        }
    }
}

/// The worker key of a lab's attack VM operation.
pub fn attack_key(lab_id: &str) -> String {
    format!("{lab_id}.attack")
}

/// Runs a job in this process (the worker's body, and the in-app fallback when no worker could
/// be started), logging to `log`. A launch returns the lab's local URL.
pub async fn execute(app: &AppHandle, job: Job, log: impl Fn(String)) -> Result<Option<String>> {
    match job.op {
        Op::Launch => crate::labs::run(app, job.launch, job.provider, job.host.as_deref(), job.attackbox_image.as_deref(), log).await,
        Op::Resume { runtime } => crate::runtime::resume_lab(app, &job.lab_id, runtime, log).await.map(|_| None),
        Op::Park { runtime, mode } => crate::runtime::park_lab(app, &job.lab_id, runtime, mode, log).await.map(|_| None),
        Op::Provision { runtime, machine } => crate::runtime::provision_lab(app, &job.lab_id, runtime, machine.as_deref(), log).await.map(|_| None),
        Op::AttackVm { box_name } => crate::runtime::start_attack_vm(app, &job.lab_id, &box_name, log).await.map(|_| None),
    }
}

/// Runs `job` detached (a worker process), following its log into `logs` until it finishes;
/// falls back to running it in this process (on a task that outlives a webview reload) when no
/// worker can be started. Refuses while another operation of the same key is in progress.
pub async fn run_job(app: &AppHandle, job: Job, logs: tauri::ipc::Channel<String>) -> Result<()> {
    if running(app).contains(&job.key()) {
        return Err(Error::Invalid(format!("{} of this lab is already in progress; wait for it to finish.", capitalize(job.what()))));
    }
    match spawn(app, &job) {
        Ok(spawned) => {
            let follow = logs.clone();
            tail(&spawned, move |line| {
                let _ = follow.send(line);
            })
            .await
        }
        // Fallback: run in this process, on a detached task (a webview reload aborts this command
        // future and the child is kill_on_drop, so inline would be cut short). The app then has
        // to stay open until it finishes; the quit guard keeps it alive.
        Err(e) => {
            let _ = logs.send(format!("Running inside the app (a background worker couldn't be started: {e}). Keep the app open until it finishes."));
            let app = app.clone();
            let handle = tauri::async_runtime::spawn(async move {
                let log = move |line: String| {
                    let _ = logs.send(line);
                };
                execute(&app, job, log).await
            });
            handle.await.map_err(|e| Error::Invalid(format!("the task did not finish: {e}")))??;
            Ok(())
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// A worker's files.
pub struct Files {
    pub job: PathBuf,
    pub log: PathBuf,
    pub pid: PathBuf,
    pub status: PathBuf,
}

/// A worker just started: its files and its process id.
pub struct Spawned {
    pub files: Files,
    pub pid: u32,
}

fn dir(app: &AppHandle) -> Result<PathBuf> {
    let d = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("deploys");
    std::fs::create_dir_all(&d).map_err(Error::Io)?;
    Ok(d)
}

/// Whether the lab's last finished deploy failed (its worker wrote `error: …`). A run still in
/// progress, or none at all, isn't a failure.
pub fn last_deploy_failed(app: &AppHandle, lab_id: &str) -> bool {
    let Ok(d) = dir(app) else { return false };
    let f = files(&d, lab_id);
    if read_pid(&f.pid).is_some_and(alive) {
        return false;
    }
    std::fs::read_to_string(&f.status).is_ok_and(|s| s.trim_start().starts_with("error"))
}

fn files(dir: &Path, lab_id: &str) -> Files {
    Files {
        job: dir.join(format!("{lab_id}.json")),
        log: dir.join(format!("{lab_id}.log")),
        pid: dir.join(format!("{lab_id}.pid")),
        status: dir.join(format!("{lab_id}.status")),
    }
}

/// Starts the worker for `job`, detached from this process. `Err` when it can't be started; the
/// caller then deploys in-process as a fallback.
pub fn spawn(app: &AppHandle, job: &Job) -> Result<Spawned> {
    crate::runtime::validate_id(&job.lab_id)?;
    let f = files(&dir(app)?, &job.key());
    // A fresh run: no verdict or log left from an earlier one.
    let _ = std::fs::remove_file(&f.status);
    std::fs::write(&f.job, serde_json::to_vec(job).map_err(|e| Error::Invalid(e.to_string()))?).map_err(Error::Io)?;
    let log = std::fs::File::create(&f.log).map_err(Error::Io)?;
    let exe = std::env::current_exe().map_err(Error::Io)?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("deploy").arg("--job").arg(&f.job).stdin(std::process::Stdio::null()).stdout(log.try_clone().map_err(Error::Io)?).stderr(log);
    // Its own process group (and session leader on unix): closing the app's terminal or the app
    // itself sends it nothing, and stopping it later stops its children too.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = cmd.spawn().map_err(Error::Io)?;
    let pid = child.id();
    std::fs::write(&f.pid, pid.to_string()).map_err(Error::Io)?;
    // Reaped when it exits: unreaped, a finished worker stays a zombie for as long as the app
    // runs, and a zombie still answers `kill -0`. Its pidfile goes with it: a worker that
    // finished before the line above wrote the pidfile would otherwise leave one behind.
    let pidfile = f.pid.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        if read_pid(&pidfile) == Some(pid) {
            let _ = std::fs::remove_file(&pidfile);
        }
    });
    Ok(Spawned { files: f, pid })
}

/// Whether `pid` is a live deploy worker: running (not a zombie) and this app's `deploy --job`
/// process, not another program that got the number of a worker long gone.
fn alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        // The state follows the command name, which is in parentheses and may hold spaces.
        let state = stat.rsplit_once(") ").and_then(|(_, rest)| rest.chars().next());
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        state.is_some_and(|c| c != 'Z' && c != 'X') && is_worker(&String::from_utf8_lossy(&cmdline).replace('\0', " "))
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        std::process::Command::new("ps")
            .args(["-o", "stat=,command=", "-p", &pid.to_string()])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .is_some_and(|l| !l.starts_with('Z') && is_worker(&l))
    }
    #[cfg(windows)]
    {
        crate::exec::headless_std(std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]))
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

/// A deploy worker's command line: `<app> deploy --job <file>`.
fn is_worker(cmdline: &str) -> bool {
    cmdline.contains(" deploy ") && cmdline.contains("--job")
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok())
}

/// The keys (lab ids, and `<lab>.attack` for attack VM starts) whose worker is running right
/// now: a pidfile naming a live process. A pidfile whose process is gone (the worker finished,
/// or died) is removed on the way.
pub fn running(app: &AppHandle) -> Vec<String> {
    let Ok(d) = dir(app) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&d) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("pid") {
            continue;
        }
        let Some(id) = p.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        match read_pid(&p) {
            Some(pid) if alive(pid) => out.push(id),
            _ => {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    out.sort();
    out
}

/// The jobs whose worker runs right now, each with the step its log is at (for the sidebar).
pub fn running_jobs(app: &AppHandle) -> Vec<(Job, Option<String>)> {
    let Ok(d) = dir(app) else { return Vec::new() };
    running(app)
        .into_iter()
        .filter_map(|key| {
            let f = files(&d, &key);
            let job: Job = serde_json::from_slice(&std::fs::read(&f.job).ok()?).ok()?;
            let step = std::fs::read_to_string(&f.log).ok().and_then(|l| last_step(&l));
            Some((job, step))
        })
        .collect()
}

/// The step a worker's log is at: the last Vagrant action line (`==> dc01: Booting VM...`) as
/// `dc01: Booting VM...`, else the last non-empty line, kept short. Vagrant's own progress
/// chatter (download percentages, blank spacers) never counts as a step.
pub fn last_step(log: &str) -> Option<String> {
    let mut last_action: Option<String> = None;
    let mut last_line: Option<String> = None;
    for raw in log.lines() {
        let l = raw.trim();
        if l.is_empty() || l.starts_with('✓') || l.starts_with('✗') {
            continue;
        }
        if let Some(rest) = l.strip_prefix("==>") {
            let rest = rest.trim();
            // "dc01: Booting VM..." keeps the machine; "dc01: " alone (a spacer) does not count.
            if rest.split_once(':').is_some_and(|(_, text)| !text.trim().is_empty()) {
                last_action = Some(rest.to_string());
            }
            continue;
        }
        last_line = Some(l.to_string());
    }
    let step = last_action.or(last_line)?;
    Some(if step.chars().count() > 72 { format!("{}…", step.chars().take(71).collect::<String>()) } else { step })
}

/// Stops the worker of `key` (a lab id, or its attack VM's key), with everything it started
/// (its process group), if one runs.
pub fn kill(app: &AppHandle, key: &str) {
    let Ok(d) = dir(app) else { return };
    let f = files(&d, key);
    if let Some(pid) = read_pid(&f.pid)
        && alive(pid)
    {
        #[cfg(unix)]
        {
            // The negative pid is the process group: the worker and its vagrant/docker/terraform.
            let _ = std::process::Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
        }
        #[cfg(windows)]
        {
            let _ = crate::exec::headless_std(std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])).status();
        }
    }
    let _ = std::fs::remove_file(&f.pid);
}

/// [`kill`], then waits until the worker is gone (SIGKILL to its group after 20 s), so what
/// follows (a teardown) never races a `compose up` or `vagrant up` that is still creating what
/// it removes.
pub async fn kill_and_wait(app: &AppHandle, key: &str) {
    let Ok(d) = dir(app) else { return };
    let Some(pid) = read_pid(&files(&d, key).pid).filter(|p| alive(*p)) else { return };
    kill(app, key);
    for _ in 0..40 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
    }
    for _ in 0..10 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// The log of a lab's latest deploy so far, for an app that (re)attaches to a running worker.
pub fn log_so_far(app: &AppHandle, lab_id: &str) -> Result<String> {
    crate::runtime::validate_id(lab_id)?;
    let f = files(&dir(app)?, lab_id);
    Ok(std::fs::read_to_string(&f.log).unwrap_or_default())
}

/// How a failed run's last log line starts (the UI marks a run failed by it).
const FAILED_MARK: &str = "✗";

/// The verdict in a status file: `Ok` for `ok`, the message otherwise.
fn verdict(status: &str) -> Result<()> {
    let s = status.trim();
    if s == "ok" { Ok(()) } else { Err(Error::Invalid(s.strip_prefix("error: ").unwrap_or(s).to_string())) }
}

/// Follows a worker's log line by line into `log` until it finishes; its status file is the
/// result. A worker that vanishes without a status is an error (its log says what happened).
pub async fn tail(spawned: &Spawned, mut log: impl FnMut(String)) -> Result<()> {
    let f = &spawned.files;
    let mut offset = 0usize;
    let mut carry = String::new();
    let mut grace = 0u8;
    loop {
        if let Ok(bytes) = std::fs::read(&f.log)
            && bytes.len() > offset
        {
            carry.push_str(&String::from_utf8_lossy(&bytes[offset..]));
            offset = bytes.len();
            while let Some(i) = carry.find('\n') {
                let line = carry[..i].to_string();
                carry = carry[i + 1..].to_string();
                // The worker's closing ✗ line restates its verdict, which the caller reports.
                if !line.starts_with(FAILED_MARK) {
                    log(line);
                }
            }
        }
        if let Ok(status) = std::fs::read_to_string(&f.status) {
            if !carry.is_empty() {
                log(std::mem::take(&mut carry));
            }
            return verdict(&status);
        }
        if !alive(spawned.pid) {
            // The status is written just before the worker exits: give it a moment to land.
            grace += 1;
            if grace > 4 {
                return Err(Error::Invalid("the deploy worker stopped without a result (see its log)".into()));
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// The worker's entry point, in place of the app: a headless Tauri app on the same data dir
/// (so lab, key and server paths resolve the same), the deploy, a status file, then exit.
pub fn worker_main(job_path: PathBuf, mut context: tauri::Context) {
    let job: Job = match std::fs::read(&job_path).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(j) => j,
        None => {
            eprintln!("deploy worker: unreadable job file {}", job_path.display());
            std::process::exit(2);
        }
    };
    // No window: this is a background process.
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            // A background process, not an app: on macOS keep it out of the Dock, the app
            // switcher and Apple Events aimed at "Cyber CTF".
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let code = deploy(&handle, job).await;
                handle.exit(code);
            });
            Ok(())
        })
        .build(context)
        .expect("error while starting the deploy worker")
        .run(|_, event| {
            // Only the deploy ends the worker (`handle.exit(code)` carries its code). A quit from
            // outside (a script or tool quitting "Cyber CTF") reached it once and killed a deploy
            // mid-way, orphaning vagrant with no status written.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}

/// Runs the job, logging to its file (also this process's stdout/stderr, for panics), and leaves
/// the verdict in the status file.
async fn deploy(app: &AppHandle, job: Job) -> i32 {
    let Ok(d) = dir(app) else { return 2 };
    let f = files(&d, &job.key());
    let sink = std::sync::Mutex::new(std::fs::OpenOptions::new().append(true).create(true).open(&f.log).ok());
    let log = |line: String| {
        if let Ok(mut guard) = sink.lock()
            && let Some(file) = guard.as_mut()
        {
            let _ = writeln!(file, "{line}");
        }
    };
    let result = execute(app, job, &log).await;
    // The log file says how it ended too, so a page that re-attaches to it after a reload or a
    // relaunch (it has no live verdict) still sees the run failed.
    if let Err(e) = &result {
        log(format!("{FAILED_MARK} {e}"));
    }
    let (status, code) = match &result {
        Ok(_) => ("ok".to_string(), 0),
        Err(e) => (format!("error: {e}"), 1),
    };
    let _ = std::fs::write(&f.status, status);
    let _ = std::fs::remove_file(&f.pid);
    code
}

#[cfg(test)]
mod tests {
    use super::{Job, Op, verdict};

    #[test]
    fn job_files_from_before_operations_existed_still_read_as_launches() {
        let old = r#"{"lab_id":"lab-1","launch":{"labId":"lab-1"},"provider":null,"host":null,"attackbox_image":null}"#;
        let job: Job = serde_json::from_str(old).unwrap();
        assert_eq!(job.op, Op::Launch);
        assert_eq!(job.key(), "lab-1");
    }

    #[test]
    fn lab_operations_round_trip_and_the_attack_vm_keeps_its_own_key() {
        for op in [
            Op::Resume { runtime: crate::runtime::Runtime::Vm },
            Op::Park { runtime: crate::runtime::Runtime::Docker, mode: crate::runtime::Park::Shutdown },
            Op::Provision { runtime: crate::runtime::Runtime::Vm, machine: Some("ws01".into()) },
            Op::AttackVm { box_name: "kalilinux/rolling".into() },
        ] {
            let job = Job::on_lab("lab-1", op);
            let bytes = serde_json::to_vec(&job).unwrap();
            assert_eq!(serde_json::from_slice::<Job>(&bytes).unwrap(), job);
        }
        assert_eq!(Job::on_lab("lab-1", Op::AttackVm { box_name: "a/b".into() }).key(), "lab-1.attack");
        assert_eq!(Job::on_lab("lab-1", Op::Resume { runtime: crate::runtime::Runtime::Vm }).key(), "lab-1");
    }

    #[test]
    fn job_round_trips_through_its_file_format() {
        let job = Job {
            lab_id: "lab-1".into(),
            op: Op::Launch,
            launch: serde_json::json!({ "labId": "lab-1", "runtime": "DOCKER", "repository": "CyberCTF/x", "commit": "abc", "env": [] }),
            provider: Some(crate::runtime::providers::Provider::Virtualbox),
            host: None,
            attackbox_image: Some("cyberctf/attack-box".into()),
        };
        let bytes = serde_json::to_vec(&job).unwrap();
        assert_eq!(serde_json::from_slice::<Job>(&bytes).unwrap(), job);
    }

    #[test]
    fn last_step_prefers_vagrants_action_lines_and_skips_spacers() {
        let log = "Starting the lab…\n==> dc01: Importing base box 'x'...\n    dc01: 42%\n==> dc01: Booting VM...\n==> dc01: \n\n";
        assert_eq!(super::last_step(log).as_deref(), Some("dc01: Booting VM..."));
        // No Vagrant lines yet: the launcher's own last line.
        assert_eq!(super::last_step("Downloading CyberCTF/x@abc\nLab installed\n").as_deref(), Some("Lab installed"));
        assert_eq!(super::last_step("\n\n"), None);
        // Long lines are kept readable.
        let long = format!("==> ws01: {}", "a".repeat(200));
        assert!(super::last_step(&long).unwrap().ends_with('…'));
    }

    #[test]
    fn only_a_deploy_worker_counts_as_one() {
        assert!(super::is_worker("/usr/bin/cyberctf-desktop deploy --job /data/deploys/lab-1.json"));
        assert!(!super::is_worker("/usr/bin/firefox-esr --new-window"));
        assert!(!super::is_worker(""));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_finished_or_foreign_process_is_not_alive() {
        // This test binary is alive but isn't a worker; a reaped child is gone.
        assert!(!super::alive(std::process::id()));
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!super::alive(pid));
    }

    #[test]
    fn verdict_reads_ok_and_errors() {
        assert!(verdict("ok\n").is_ok());
        let err = verdict("error: Docker isn't running").unwrap_err();
        assert!(format!("{err:?}").contains("Docker isn't running"));
        // A bare message is still an error, kept whole.
        assert!(verdict("something else").is_err());
    }
}
