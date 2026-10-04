//! Bringing a lab up and tearing it down.

use std::path::Path;

use super::compose;
use crate::error::{Error, Result};

/// A host port is taken if we can't bind it (another lab, or anything else, holds it).
fn port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_err()
}

async fn is_running(dir: &Path, project: &str) -> bool {
    match compose::output(dir, project, &["ps", "--format", "json"]).await {
        Ok(out) => compose::parse_ps(&out).iter().any(|e| e.state == "running"),
        Err(_) => false,
    }
}

async fn published_host_ports(dir: &Path, project: &str, env: &[(String, String)]) -> Vec<u16> {
    match compose::output_env(dir, project, &["config", "--format", "json"], env).await {
        Ok(out) => compose::host_ports_from_config(&out),
        Err(_) => Vec::new(),
    }
}

pub async fn start(dir: &Path, id: &str, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    let project = compose::project(id);
    // Two labs can't share a host port. Unless this lab is already up (idempotent restart),
    // refuse up front with a clear message instead of a cryptic Docker bind error.
    if !is_running(dir, &project).await {
        for port in published_host_ports(dir, &project, env).await {
            if port_in_use(port) {
                return Err(Error::Invalid(format!(
                    "Host port {port} is already in use — another lab is probably using it. Stop that lab, then start this one."
                )));
            }
        }
    }
    compose::stream(dir, &project, &["up", "-d", "--pull", "missing", "--wait"], env, log).await
}

/// Removes containers, networks and volumes: the next start is a clean lab.
pub async fn stop(dir: &Path, id: &str, log: impl FnMut(String)) -> Result<()> {
    let project = compose::project(id);
    compose::stream(dir, &project, &["down", "--volumes", "--remove-orphans"], &[], log).await
}
