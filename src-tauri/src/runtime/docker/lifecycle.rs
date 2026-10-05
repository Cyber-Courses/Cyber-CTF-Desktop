//! Bringing a lab up and tearing it down.

use std::path::Path;

use super::compose;
use crate::error::{Error, Result};
use crate::exec::{run, run_read};

/// Fails fast with a clear message when the Docker engine isn't reachable, instead of letting
/// `compose up` (or the port/config probes) surface a raw "Cannot connect to the Docker daemon".
/// Timed, so a wedged daemon can't hang the start.
async fn ensure_docker_up() -> Result<()> {
    run_read("docker", &["info", "--format", "{{.ServerVersion}}"], None)
        .await
        .map(|_| ())
        .map_err(|_| Error::Invalid("Docker isn't running. Start Docker Desktop (or your container engine), then start the lab again.".into()))
}

/// A host port is taken if we can't bind it (another lab, or anything else, holds it). Checks
/// every interface a container can publish to: all interfaces and the loopback specifically
/// (a port held only on 127.0.0.1 doesn't fail the 0.0.0.0 bind on its own).
fn port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_err() || std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

async fn is_running(dir: &Path, project: &str) -> bool {
    match compose::output(dir, project, &["ps", "--format", "json"]).await {
        Ok(out) => compose::parse_ps(&out).iter().any(|e| e.state == "running"),
        Err(_) => false,
    }
}

async fn published_host_ports(dir: &Path, project: &str, env: &[(String, String)]) -> Result<Vec<u16>> {
    let out = compose::output_env(dir, project, &["config", "--format", "json"], env).await?;
    Ok(compose::host_ports_from_config(&out))
}

pub async fn start(dir: &Path, id: &str, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    // A stopped engine otherwise surfaces as a raw daemon-connection error much later.
    ensure_docker_up().await?;
    let project = compose::project(id);
    // Two labs can't share a host port. Unless this lab is already up (idempotent restart),
    // refuse up front with a clear message instead of a cryptic Docker bind error. With the
    // engine confirmed up, a failure reading the ports is a real Compose-config error worth
    // surfacing now rather than letting `up` fail on it.
    if !is_running(dir, &project).await {
        for port in published_host_ports(dir, &project, env).await? {
            if port_in_use(port) {
                return Err(Error::Invalid(format!(
                    "Host port {port} is already in use — another lab is probably using it. Stop that lab, then start this one."
                )));
            }
        }
    }
    remove_stale_networks(dir, &project, env).await;
    // --wait blocks until containers are healthy; bound it so a container stuck in a failing
    // healthcheck surfaces as a timeout instead of hanging the start indefinitely.
    compose::stream(dir, &project, &["up", "-d", "--pull", "missing", "--wait", "--wait-timeout", "600"], env, log).await
}

/// Networks of this lab that its current Compose file no longer defines (left by an older
/// version of the lab), so tools listing the lab's networks don't pick a dead one. Whatever
/// is still plugged into one (the attack box) is unplugged first. Best effort.
async fn remove_stale_networks(dir: &Path, project: &str, env: &[(String, String)]) {
    let Ok(config) = compose::output_env(dir, project, &["config", "--format", "json"], env).await else { return };
    let wanted: Vec<String> = serde_json::from_str::<serde_json::Value>(&config)
        .ok()
        .and_then(|v| {
            v.get("networks")
                .and_then(|n| n.as_object())
                .map(|n| n.iter().map(|(k, v)| v["name"].as_str().map(str::to_string).unwrap_or_else(|| format!("{project}_{k}"))).collect())
        })
        .unwrap_or_default();
    let filter = format!("label=com.docker.compose.project={project}");
    let Ok(listed) = run("docker", &["network", "ls", "--filter", &filter, "--format", "{{.Name}}"], None).await else { return };
    for net in listed.lines().map(str::trim).filter(|n| !n.is_empty() && !wanted.iter().any(|w| w == n)) {
        if let Ok(attached) = run("docker", &["network", "inspect", "-f", "{{range .Containers}}{{.Name}} {{end}}", net], None).await {
            for c in attached.split_whitespace() {
                let _ = run("docker", &["network", "disconnect", "-f", net, c], None).await;
            }
        }
        let _ = run("docker", &["network", "rm", net], None).await;
    }
}

/// Removes containers, networks and volumes: the next start is a clean lab.
pub async fn stop(dir: &Path, id: &str, log: impl FnMut(String)) -> Result<()> {
    let project = compose::project(id);
    compose::stream(dir, &project, &["down", "--volumes", "--remove-orphans"], &[], log).await
}
