//! The lab's self-check: its Isoloom `checks:` (the lab's own scripts and declared probes, and
//! the ones Isoloom derives from `services` and `reach`), run by the Compose file's check
//! runners (profile `check`), one per position, read into a per-check table.

use std::path::Path;

use isoloom_core::checks::{self, Line};

use super::compose;
use crate::error::Result;

/// One check's outcome.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub name: String,
    /// Where it ran: "from web", or "from the environment's networks".
    pub from: String,
    pub ok: bool,
    /// Why it failed (empty when it passed).
    pub reason: String,
}

/// Result of a lab's self-verification.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// The lab has checks (its own, or derived from its spec), so verification is possible.
    pub available: bool,
    /// Every check passed: the lab behaves, and the challenge is still in a solvable state.
    pub ok: bool,
    /// The runners' combined output.
    pub output: String,
    /// Every check, in the order it ran.
    pub results: Vec<CheckResult>,
}

/// Runs every check runner of the lab (compose `check` profile): containers on the lab's
/// networks that assert what the lab declares and that the intended exploit path still
/// works, so a learner who broke their box is told to reset it instead of fighting a lab that
/// can no longer be solved.
pub async fn check(dir: &Path, id: &str) -> Result<Check> {
    let spec = crate::runtime::lab::spec(dir)?;
    let plan = checks::plan(&spec);
    if plan.is_empty() {
        return Ok(Check { available: false, ok: false, output: String::new(), results: Vec::new() });
    }
    let default = checks::default_position(&spec);
    let project = compose::project(id);
    let mut lines: Vec<String> = Vec::new();
    let mut results: Vec<CheckResult> = Vec::new();
    let mut ran = true;
    for (pos, group) in checks::by_position(&spec, &plan) {
        let service =
            if pos == default { crate::runtime::lab::CHECK_SERVICE.to_string() } else { format!("{}-{}", crate::runtime::lab::CHECK_SERVICE, pos.id()) };
        let from = pos.label();
        // `exec` checks run inside the machine, from their own runner (Isoloom's exec-<machine>.sh,
        // piped in); the runner beside the machine reports the others.
        let (execs, group): (Vec<&checks::Resolved>, Vec<&checks::Resolved>) = group.into_iter().partition(|c| matches!(c.probe, checks::Probe::Exec { .. }));
        let before = results.len();
        let res = compose::stream(dir, &project, &["--profile", "check", "run", "--rm", "--no-deps", &service], &[], |l| {
            match checks::parse_line(&l) {
                Some(Line::Pass(name)) => results.push(CheckResult { name, from: from.clone(), ok: true, reason: String::new() }),
                Some(Line::Fail(name, why)) => results.push(CheckResult { name, from: from.clone(), ok: false, reason: why }),
                Some(Line::End(..)) | None => {}
            }
            lines.push(l);
        })
        .await;
        // A runner that stopped before reporting: the checks it owned, failed with that reason.
        let reported = results.len() - before;
        for c in group.iter().skip(reported) {
            results.push(CheckResult { name: c.name.clone(), from: from.clone(), ok: false, reason: "the runner stopped before this check".into() });
        }
        if res.is_err() {
            ran = false;
        }
        if let (false, checks::Position::Machine(m)) = (execs.is_empty(), &pos) {
            let file = crate::runtime::lab::compose_file(dir).with_file_name("checks").join(isoloom_core::generate::exec_runner(m));
            let from = format!("inside {m}");
            let before = results.len();
            let res = compose::stream_with_stdin(dir, &project, &["exec", "-T", m, "sh", "-s"], &file, |l| {
                match checks::parse_line(&l) {
                    Some(Line::Pass(name)) => results.push(CheckResult { name, from: from.clone(), ok: true, reason: String::new() }),
                    Some(Line::Fail(name, why)) => results.push(CheckResult { name, from: from.clone(), ok: false, reason: why }),
                    Some(Line::End(..)) | None => {}
                }
                lines.push(l);
            })
            .await;
            let reported = results.len() - before;
            for c in execs.iter().skip(reported) {
                results.push(CheckResult { name: c.name.clone(), from: from.clone(), ok: false, reason: "the runner stopped before this check".into() });
            }
            if res.is_err() {
                ran = false;
            }
        }
    }
    let ok = ran && results.iter().all(|r| r.ok);
    Ok(Check { available: true, ok, output: lines.join("\n"), results })
}
