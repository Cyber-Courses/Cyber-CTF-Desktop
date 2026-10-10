//! Setup self-tests: prove this machine can actually run labs, not just that the tools exist.
//!
//! - `docker`: a throwaway two-container lab (busybox, ~2 MB). It checks the engine answers,
//!   an image pulls, compose starts the lab, containers reach each other by name on the lab
//!   network, and a published port is reachable from this machine. Always cleaned up.
//! - `vm`: a real throwaway VM on the first usable local hypervisor. It checks the
//!   hypervisor answers, gets a small test box (once, then cached), boots it on a private
//!   lab network, runs a command inside it, pings it from this machine, then destroys it.
//!
//! Progress goes to the UI as one event per step: `running`, then `ok` or `fail`.

mod docker;
mod downloads;
mod vm;

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::runtime::providers::Provider;

pub(crate) use docker::IMAGE;
pub(crate) use vm::candidate_boxes;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Docker,
    Vm,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub step: &'static str,
    pub label: &'static str,
    /// `running`, `ok`, `fail` or `skip`.
    pub state: &'static str,
    pub detail: Option<String>,
}

/// Longest live output line shown under a running step, in characters.
const PROGRESS_MAX: usize = 160;

struct Reporter(Channel<Event>);

impl Reporter {
    /// Live output for a step that is still running (shown as its detail line).
    fn progress(&self, step: &'static str, label: &'static str, line: String) {
        let line = line.trim();
        if !line.is_empty() {
            self.send(step, label, "running", Some(line.chars().take(PROGRESS_MAX).collect()));
        }
    }

    fn send(&self, step: &'static str, label: &'static str, state: &'static str, detail: Option<String>) {
        let _ = self.0.send(Event { step, label, state, detail });
    }

    /// Runs one step, reporting it; a failure stops the test with that step's error.
    async fn step<T>(&self, step: &'static str, label: &'static str, fut: impl std::future::Future<Output = Result<(T, Option<String>)>>) -> Result<T> {
        self.send(step, label, "running", None);
        match fut.await {
            Ok((v, detail)) => {
                self.send(step, label, "ok", detail);
                Ok(v)
            }
            Err(e) => {
                self.send(step, label, "fail", Some(explain(&e.to_string())));
                Err(e)
            }
        }
    }

    /// The closing clean-up step, reported only when the test itself passed (a failed test
    /// already says what went wrong).
    fn cleanup<T>(&self, label: &'static str, test: &Result<()>, done: Result<T>, ok_detail: Option<String>) {
        match (test, done) {
            (Ok(()), Ok(_)) => self.send("cleanup", label, "ok", ok_detail),
            (Ok(()), Err(e)) => self.send("cleanup", label, "fail", Some(e.to_string())),
            (Err(_), _) => {}
        }
    }
}

/// A plain-language hint for the failures people actually hit, in front of the raw error (kept
/// as the detail). Unknown errors pass through unchanged.
fn explain(raw: &str) -> String {
    let hint = if raw.contains("type=kvm") || raw.contains("preferred machine") {
        "KVM isn't usable by this user. Check that /dev/kvm exists and that you are in the kvm and libvirt groups, then run the test again."
    } else if raw.contains("Cannot connect to the Docker daemon") || raw.contains("docker.sock") {
        "The container engine isn't reachable. Start Docker and check that your user can use it (the docker group), then run the test again."
    } else {
        return raw.to_string();
    };
    format!("{hint} Details: {raw}")
}

pub(crate) fn work_dir(app: &AppHandle, kind: &str) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("selftest").join(kind);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Whether this machine's CPU is ARM (the test boxes differ).
fn arm() -> bool {
    std::env::consts::ARCH == "aarch64"
}

/// Starts the test downloads early (called when setup opens). Errors are ignored by the UI:
/// the test itself retries and reports them.
#[tauri::command]
pub async fn machine_selftest_prefetch(app: AppHandle, kind: Kind, provider: Option<Provider>) -> Result<()> {
    match kind {
        Kind::Docker => downloads::ensure_image().await.map(|_| ()),
        Kind::Vm => {
            let Some(p) = vm::test_provider(provider).await else { return Ok(()) };
            let (bx, cached) = vm::pick_box(p, arm()).await;
            if cached {
                return Ok(());
            }
            downloads::ensure_box(&work_dir(&app, "vm")?, p, bx, arm(), |_| {}).await.map(|_| ())
        }
    }
}

#[tauri::command]
pub async fn machine_selftest(app: AppHandle, kind: Kind, provider: Option<Provider>, events: Channel<Event>) -> Result<()> {
    let r = Reporter(events);
    match kind {
        Kind::Docker => docker::run_test(&work_dir(&app, "docker")?, &r).await,
        Kind::Vm => vm::run_test(&work_dir(&app, "vm")?, provider, &r).await,
    }
}

#[cfg(test)]
mod tests {
    use super::explain;

    #[test]
    fn kvm_failure_gets_a_hint_and_keeps_the_details() {
        let raw = "could not get preferred machine for /usr/bin/qemu-system-x86_64 type=kvm";
        let out = explain(raw);
        assert!(out.starts_with("KVM isn't usable"));
        assert!(out.ends_with(raw));
    }

    #[test]
    fn unknown_errors_pass_through_unchanged() {
        assert_eq!(explain("something else broke"), "something else broke");
    }
}
