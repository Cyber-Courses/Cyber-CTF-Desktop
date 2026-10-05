//! The lab's exploitability self-check: the lab's Isoloom `checks:`, run by the Compose file's
//! `isoloom-check` service (profile `check`) on the lab networks.

use std::path::Path;

use super::compose;
use crate::error::Result;

/// Result of a lab's self-verification (the `check` service).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// The lab ships a `check` service, so verification is possible.
    pub available: bool,
    /// The check passed: the challenge is still in a solvable state.
    pub ok: bool,
    /// The check's combined output (why it failed, when it did).
    pub output: String,
}

/// Runs the lab's `check` service (compose `check` profile): a container on the lab network
/// that asserts the intended exploit path still works, so a learner who broke their box is
/// told to reset it instead of fighting a lab that can no longer be solved. Exit 0 = solvable.
pub async fn check(dir: &Path, id: &str) -> Result<Check> {
    let project = compose::project(id);
    let service = crate::runtime::lab::CHECK_SERVICE;
    let config = compose::output(dir, &project, &["--profile", "check", "config", "--format", "json"]).await.ok();
    if !config.as_deref().map(|c| compose::config_has_service(c, service)).unwrap_or(false) {
        return Ok(Check { available: false, ok: false, output: String::new() });
    }
    let mut lines: Vec<String> = Vec::new();
    let res = compose::stream(dir, &project, &["--profile", "check", "run", "--rm", "--no-deps", service], &[], |l| lines.push(l)).await;
    Ok(Check { available: true, ok: res.is_ok(), output: lines.join("\n") })
}
