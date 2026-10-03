use std::path::Path;

use serde::Deserialize;

use super::{LabStatus, Machine, Port};
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
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Publishers", default)]
    publishers: Vec<Publisher>,
}

#[derive(Deserialize)]
struct Publisher {
    #[serde(rename = "PublishedPort", default)]
    published_port: u16,
    #[serde(rename = "TargetPort", default)]
    target_port: u16,
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

/// Each running container's address on the lab network, keyed by container name.
/// `docker compose ps` doesn't carry the IP, so we inspect the live containers once.
/// Best effort: an empty map (e.g. inspect failed) just means the UI shows no IPs.
async fn container_ips(dir: &Path, names: &[String]) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    if names.is_empty() {
        return HashMap::new();
    }
    let mut args: Vec<&str> = vec!["inspect", "-f", "{{.Name}}\t{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"];
    args.extend(names.iter().map(String::as_str));
    let out = match run("docker", &args, Some(dir)).await {
        Ok(out) => out,
        Err(_) => return HashMap::new(),
    };
    out.lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once('\t')?;
            let ip = rest.split_whitespace().next()?.to_string();
            Some((name.trim_start_matches('/').to_string(), ip))
        })
        .collect()
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
    let entries = parse_ps(&out);
    // Labs have one-shot init services (e.g. evidence, place-evidence) that exit 0 after
    // doing their job, so the lab is "running" when at least one service is up, not when
    // every service is. Only the live services are reported to the UI.
    let running = entries.iter().any(|e| e.state == "running");
    let url = if running { first_published_url(&entries) } else { None };
    let run_names: Vec<String> = entries.iter().filter(|e| e.state == "running").map(|e| e.name.clone()).collect();
    let ips = container_ips(dir, &run_names).await;
    let machines = entries
        .into_iter()
        .filter(|e| e.state == "running")
        .map(|e| {
            let ports = e
                .publishers
                .iter()
                .filter(|p| (p.target_port > 0 || p.published_port > 0) && (p.protocol.is_empty() || p.protocol == "tcp"))
                .map(|p| Port { published: p.published_port, target: p.target_port })
                .collect();
            let ip = ips.get(&e.name).cloned().unwrap_or_default();
            Machine { name: e.service, state: e.state, image: e.image, ip, ports }
        })
        .collect();
    Ok(LabStatus { running, machines, url, host: None })
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
