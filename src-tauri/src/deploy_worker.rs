//! Deploys that outlive the app. A deploy runs in a detached worker process: this same
//! executable, headless (`cyberctf-desktop deploy --job <file>`), in its own process group, with
//! its output in a log file. Quitting or crashing the app never cuts a `vagrant up`, a
//! `compose up` or a `terraform apply` short. The app only follows the worker's log; "deploying"
//! is a live pidfile, so a relaunched app sees the deploy and re-attaches to its log.
//!
//! Files, under `<app data>/deploys/`: `<lab>.json` (the job), `<lab>.log` (what the worker
//! says, also its stdout/stderr), `<lab>.pid` (the worker, while it runs), `<lab>.status`
//! (`ok` or `error: ...`, written last).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::runtime::providers::Provider;

/// What a worker needs to run a deploy: the `startLab` payload and where/how to run it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Job {
    pub lab_id: String,
    /// The `startLab` payload (`{ labId, runtime, repository, commit, env }`).
    pub launch: serde_json::Value,
    pub provider: Option<Provider>,
    pub host: Option<String>,
    pub attackbox_image: Option<String>,
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
    let f = files(&dir(app)?, &job.lab_id);
    // A fresh run: no verdict or log left from an earlier one.
    let _ = std::fs::remove_file(&f.status);
    std::fs::write(&f.job, serde_json::to_vec(job).map_err(|e| Error::Invalid(e.to_string()))?).map_err(Error::Io)?;
    let log = std::fs::File::create(&f.log).map_err(Error::Io)?;
    let exe = std::env::current_exe().map_err(Error::Io)?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("deploy")
        .arg("--job")
        .arg(&f.job)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(Error::Io)?)
        .stderr(log);
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
    let child = cmd.spawn().map_err(Error::Io)?;
    let pid = child.id();
    std::fs::write(&f.pid, pid.to_string()).map_err(Error::Io)?;
    Ok(Spawned { files: f, pid })
}

/// Whether `pid` is a live process.
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok())
}

/// The labs whose worker is running right now: a pidfile naming a live process. A pidfile whose
/// process is gone (the worker finished, or died) is removed on the way.
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

/// Stops a lab's worker, with everything it started (its process group), if one runs.
pub fn kill(app: &AppHandle, lab_id: &str) {
    let Ok(d) = dir(app) else { return };
    let f = files(&d, lab_id);
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
            let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
        }
    }
    let _ = std::fs::remove_file(&f.pid);
}

/// The log of a lab's latest deploy so far, for an app that (re)attaches to a running worker.
pub fn log_so_far(app: &AppHandle, lab_id: &str) -> Result<String> {
    crate::runtime::validate_id(lab_id)?;
    let f = files(&dir(app)?, lab_id);
    Ok(std::fs::read_to_string(&f.log).unwrap_or_default())
}

/// The verdict in a status file: `Ok` for `ok`, the message otherwise.
fn verdict(status: &str) -> Result<()> {
    let s = status.trim();
    if s == "ok" {
        Ok(())
    } else {
        Err(Error::Invalid(s.strip_prefix("error: ").unwrap_or(s).to_string()))
    }
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
                log(line);
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
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let code = deploy(&handle, job).await;
                handle.exit(code);
            });
            Ok(())
        })
        .build(context)
        .expect("error while starting the deploy worker")
        .run(|_, _| {});
}

/// Runs the job, logging to its file (also this process's stdout/stderr, for panics), and leaves
/// the verdict in the status file.
async fn deploy(app: &AppHandle, job: Job) -> i32 {
    let Ok(d) = dir(app) else { return 2 };
    let f = files(&d, &job.lab_id);
    let sink = std::sync::Mutex::new(std::fs::OpenOptions::new().append(true).create(true).open(&f.log).ok());
    let log = |line: String| {
        if let Ok(mut guard) = sink.lock()
            && let Some(file) = guard.as_mut()
        {
            let _ = writeln!(file, "{line}");
        }
    };
    let result = crate::labs::run(app, job.launch, job.provider, job.host.as_deref(), job.attackbox_image.as_deref(), log).await;
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
    use super::{Job, verdict};

    #[test]
    fn job_round_trips_through_its_file_format() {
        let job = Job {
            lab_id: "lab-1".into(),
            launch: serde_json::json!({ "labId": "lab-1", "runtime": "DOCKER", "repository": "CyberCTF/x", "commit": "abc", "env": [] }),
            provider: Some(crate::runtime::providers::Provider::Virtualbox),
            host: None,
            attackbox_image: Some("cyberctf/attack-box".into()),
        };
        let bytes = serde_json::to_vec(&job).unwrap();
        assert_eq!(serde_json::from_slice::<Job>(&bytes).unwrap(), job);
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
