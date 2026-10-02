use std::path::Path;

use serde::Deserialize;

use super::{LabStatus, Machine};
use crate::error::Result;
use crate::exec::{run, stream};

// One compose project per lab, so labs never collide and can be cleaned up by name.
fn project(id: &str) -> String {
    format!("cyberctf-{id}")
}

pub async fn start(dir: &Path, id: &str, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    let project = project(id);
    stream(
        "docker",
        &["compose", "-p", &project, "-f", "docker-compose.yml", "up", "-d", "--pull", "missing", "--wait"],
        Some(dir),
        env,
        log,
    )
    .await
}

/// Removes containers, networks and volumes: the next start is a clean lab.
pub async fn stop(dir: &Path, id: &str, log: impl FnMut(String)) -> Result<()> {
    let project = project(id);
    stream(
        "docker",
        &["compose", "-p", &project, "-f", "docker-compose.yml", "down", "--volumes", "--remove-orphans"],
        Some(dir),
        &[],
        log,
    )
    .await
}

#[derive(Deserialize)]
struct PsEntry {
    #[serde(rename = "Service")]
    service: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Publishers", default)]
    publishers: Vec<Publisher>,
}

#[derive(Deserialize)]
struct Publisher {
    #[serde(rename = "PublishedPort", default)]
    published_port: u16,
    #[serde(rename = "Protocol", default)]
    protocol: String,
}

/// The loopback URL of the first published TCP port, i.e. where the lab's target is
/// reachable on this machine. None if nothing is published yet.
fn first_published_url(entries: &[PsEntry]) -> Option<String> {
    entries
        .iter()
        .flat_map(|e| &e.publishers)
        .filter(|p| p.published_port > 0 && (p.protocol.is_empty() || p.protocol == "tcp"))
        .map(|p| p.published_port)
        .min()
        .map(|port| format!("http://127.0.0.1:{port}"))
}

// `docker compose ps --format json` prints either a JSON array (older Compose)
// or one JSON object per line (Compose >= 2.21).
fn parse_ps(out: &str) -> Vec<PsEntry> {
    let trimmed = out.trim();
    if trimmed.starts_with('[') {
        return serde_json::from_str(trimmed).unwrap_or_default();
    }
    trimmed.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

pub async fn status(dir: &Path, id: &str) -> Result<LabStatus> {
    let project = project(id);
    let out = run(
        "docker",
        &["compose", "-p", &project, "-f", "docker-compose.yml", "ps", "--all", "--format", "json"],
        Some(dir),
    )
    .await?;
    let all: Vec<Machine> = parse_ps(&out)
        .into_iter()
        .map(|e| Machine { name: e.service, state: e.state })
        .collect();
    // Labs have one-shot init services (e.g. evidence, place-evidence) that exit 0 after
    // doing their job, so the lab is "running" when at least one service is up, not when
    // every service is. Only the live services are reported to the UI.
    let running = all.iter().any(|m| m.state == "running");
    let machines = all.into_iter().filter(|m| m.state == "running").collect();
    Ok(LabStatus { running, machines })
}

/// Where the lab is reachable on this machine (its first published port), once running.
pub async fn primary_url(dir: &Path, id: &str) -> Option<String> {
    let project = project(id);
    let out = run(
        "docker",
        &["compose", "-p", &project, "-f", "docker-compose.yml", "ps", "--format", "json"],
        Some(dir),
    )
    .await
    .ok()?;
    first_published_url(&parse_ps(&out))
}

#[cfg(test)]
mod tests {
    use super::{first_published_url, parse_ps};

    #[test]
    fn parses_both_compose_output_formats() {
        let lines = "{\"Service\":\"web\",\"State\":\"running\"}\n{\"Service\":\"db\",\"State\":\"exited\"}\n";
        let array = "[{\"Service\":\"web\",\"State\":\"running\"}]";
        assert_eq!(parse_ps(lines).len(), 2);
        assert_eq!(parse_ps(array)[0].service, "web");
        assert!(parse_ps("").is_empty());
    }

    #[test]
    fn finds_the_first_published_tcp_port() {
        let out = r#"[
          {"Service":"db","State":"running","Publishers":[{"PublishedPort":0,"Protocol":"tcp"}]},
          {"Service":"web","State":"running","Publishers":[{"PublishedPort":8080,"Protocol":"tcp"},{"PublishedPort":9090,"Protocol":"tcp"}]}
        ]"#;
        assert_eq!(first_published_url(&parse_ps(out)).as_deref(), Some("http://127.0.0.1:8080"));
        let none = r#"[{"Service":"web","State":"running","Publishers":[]}]"#;
        assert_eq!(first_published_url(&parse_ps(none)), None);
    }
}
