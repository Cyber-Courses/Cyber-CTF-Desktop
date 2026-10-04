use std::path::Path;

use serde::Deserialize;

use super::{Interface, LabStatus, Machine, Network, Port};
use crate::error::{Error, Result};
use crate::exec::{run, run_env, stream};

// One compose project per lab, so labs never collide and can be cleaned up by name.
fn project(id: &str) -> String {
    format!("cyberctf-{id}")
}

/// Host ports a compose file publishes, from `docker compose config` (env resolved).
fn host_ports_from_config(json: &str) -> Vec<u16> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let mut ports = Vec::new();
    if let Some(services) = v.get("services").and_then(|s| s.as_object()) {
        for svc in services.values() {
            let Some(arr) = svc.get("ports").and_then(|p| p.as_array()) else { continue };
            for p in arr {
                let published = p.get("published").and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())));
                if let Some(n) = published {
                    if n > 0 && n <= u16::MAX as u64 {
                        ports.push(n as u16);
                    }
                }
            }
        }
    }
    ports
}

/// Service names a compose file publishes a host port for, from `docker compose config`.
/// These are the lab's serving containers (web/app), as opposed to one-shot init jobs.
fn serving_services_from_config(json: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let mut names = Vec::new();
    if let Some(services) = v.get("services").and_then(|s| s.as_object()) {
        for (name, svc) in services {
            if svc.get("ports").and_then(|p| p.as_array()).is_some_and(|a| !a.is_empty()) {
                names.push(name.clone());
            }
        }
    }
    names
}

async fn published_host_ports(dir: &Path, project: &str, env: &[(String, String)]) -> Vec<u16> {
    match run_env("docker", &["compose", "-p", project, "-f", "docker-compose.yml", "config", "--format", "json"], Some(dir), env).await {
        Ok(out) => host_ports_from_config(&out),
        Err(_) => Vec::new(),
    }
}

async fn is_running(dir: &Path, project: &str) -> bool {
    match run("docker", &["compose", "-p", project, "-f", "docker-compose.yml", "ps", "--format", "json"], Some(dir)).await {
        Ok(out) => parse_ps(&out).iter().any(|e| e.state == "running"),
        Err(_) => false,
    }
}

/// A host port is taken if we can't bind it (another lab, or anything else, holds it).
fn port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_err()
}

pub async fn start(dir: &Path, id: &str, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    let project = project(id);
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

fn config_has_service(json: &str, name: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("services").and_then(|s| s.as_object()).map(|m| m.contains_key(name)))
        .unwrap_or(false)
}

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
    let project = project(id);
    let config = run("docker", &["compose", "-p", &project, "-f", "docker-compose.yml", "config", "--format", "json"], Some(dir))
        .await
        .ok();
    if !config.as_deref().map(|c| config_has_service(c, "check")).unwrap_or(false) {
        return Ok(Check { available: false, ok: false, output: String::new() });
    }
    let mut lines: Vec<String> = Vec::new();
    let res = stream(
        "docker",
        &["compose", "-p", &project, "-f", "docker-compose.yml", "--profile", "check", "run", "--rm", "--no-deps", "check"],
        Some(dir),
        &[],
        |l| lines.push(l),
    )
    .await;
    Ok(Check { available: true, ok: res.is_ok(), output: lines.join("\n") })
}

#[derive(Deserialize)]
struct PsEntry {
    #[serde(rename = "Service")]
    service: String,
    #[serde(rename = "State")]
    state: String,
    /// Compose healthcheck result: "healthy" / "unhealthy" / "starting" / "" (none declared).
    #[serde(rename = "Health", default)]
    health: String,
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

/// True for services that aren't a web UI (databases, caches, brokers): the Open button
/// must never point a browser at one.
fn is_datastore(e: &PsEntry) -> bool {
    let s = format!("{} {}", e.service, e.image).to_ascii_lowercase();
    ["mysql", "mariadb", "postgres", "redis", "mongo", "memcached", "rabbitmq", "elastic", "mssql", "oracle"]
        .iter()
        .any(|k| s.contains(k))
        || matches!(e.service.as_str(), "db" | "database")
}

/// The loopback URL of a running web service's first published TCP port, i.e. where the
/// lab's target is reachable on this machine. Only running, non-datastore services count,
/// so Open never lands on a database port or a service whose container has exited. None if
/// no web service is up and publishing yet.
fn first_published_url(entries: &[PsEntry]) -> Option<String> {
    entries
        .iter()
        .filter(|e| e.state == "running" && !is_datastore(e))
        .flat_map(|e| &e.publishers)
        .filter(|p| p.published_port > 0 && (p.protocol.is_empty() || p.protocol == "tcp"))
        .map(|p| p.published_port)
        .min()
        .map(|port| format!("http://127.0.0.1:{port}"))
}

/// The lab's own name for a Docker network: Compose prefixes the compose key with the
/// project (`cyberctf-<id>_dmz` -> `dmz`). Other names are returned unchanged.
pub fn short_network(id: &str, name: &str) -> String {
    name.strip_prefix(&format!("{}_", project(id))).unwrap_or(name).to_string()
}

/// Each running container's interfaces (network -> address), keyed by container name.
/// `docker compose ps` doesn't carry addresses, so we inspect the live containers once.
/// Best effort: an empty map (e.g. inspect failed) just means the UI shows no IPs.
async fn container_ifaces(dir: &Path, id: &str, names: &[String]) -> std::collections::HashMap<String, Vec<Interface>> {
    use std::collections::HashMap;
    if names.is_empty() {
        return HashMap::new();
    }
    let mut args: Vec<&str> = vec!["inspect", "-f", "{{.Name}}\t{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}"];
    args.extend(names.iter().map(String::as_str));
    let out = match run("docker", &args, Some(dir)).await {
        Ok(out) => out,
        Err(_) => return HashMap::new(),
    };
    parse_ifaces(id, &out)
}

fn parse_ifaces(id: &str, out: &str) -> std::collections::HashMap<String, Vec<Interface>> {
    out.lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once('\t')?;
            let ifaces = rest
                .split_whitespace()
                .filter_map(|kv| kv.split_once('='))
                .filter(|(_, ip)| !ip.is_empty())
                .map(|(net, ip)| Interface { network: short_network(id, net), ip: ip.to_string() })
                .collect();
            Some((name.trim_start_matches('/').to_string(), ifaces))
        })
        .collect()
}

/// The lab's networks (Compose labels them with the project), with subnet and isolation.
async fn lab_networks(id: &str) -> Vec<Network> {
    let filter = format!("label=com.docker.compose.project={}", project(id));
    let Ok(names) = run("docker", &["network", "ls", "--filter", &filter, "--format", "{{.Name}}"], None).await else {
        return Vec::new();
    };
    let names: Vec<&str> = names.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if names.is_empty() {
        return Vec::new();
    }
    let mut args = vec!["network", "inspect", "-f", "{{.Name}}\t{{range .IPAM.Config}}{{.Subnet}} {{end}}\t{{.Internal}}"];
    args.extend(names);
    match run("docker", &args, None).await {
        Ok(out) => parse_networks(id, &out),
        Err(_) => Vec::new(),
    }
}

fn parse_networks(id: &str, out: &str) -> Vec<Network> {
    let mut nets: Vec<Network> = out
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let name = cols.next()?.trim();
            // Docker may list an IPv6 range too; the diagram shows the IPv4 one.
            let subnets: Vec<&str> = cols.next().unwrap_or_default().split_whitespace().collect();
            let subnet = subnets.iter().find(|s| !s.contains(':')).or(subnets.first()).copied().unwrap_or_default();
            let internal = cols.next().is_some_and(|c| c.trim() == "true");
            (!name.is_empty()).then(|| Network { name: short_network(id, name), subnet: subnet.to_string(), internal })
        })
        .collect();
    nets.sort_by(|a, b| a.name.cmp(&b.name));
    nets
}

/// A container's TCP ports, once each. Docker lists a published port once per address
/// family (0.0.0.0 and ::), which would otherwise draw every door twice.
fn tcp_ports(publishers: &[Publisher]) -> Vec<Port> {
    let mut seen = std::collections::HashSet::new();
    publishers
        .iter()
        .filter(|p| (p.target_port > 0 || p.published_port > 0) && (p.protocol.is_empty() || p.protocol == "tcp"))
        .filter(|p| seen.insert((p.published_port, p.target_port)))
        .map(|p| Port { published: p.published_port, target: p.target_port })
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
    let mut ifaces = container_ifaces(dir, id, &run_names).await;
    let networks = if running { lab_networks(id).await } else { Vec::new() };
    // Serving containers (those that publish a port) that should be up but aren't: a lab
    // whose web died is reported degraded, not fine. One-shot init jobs publish nothing, so
    // their normal exit is ignored. Config is only consulted while the lab is up.
    let serving = if running {
        run("docker", &["compose", "-p", &project, "-f", "docker-compose.yml", "config", "--format", "json"], Some(dir))
            .await
            .ok()
            .map(|c| serving_services_from_config(&c))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let down: Vec<(String, String)> = entries
        .iter()
        .filter(|e| e.state != "running" && serving.iter().any(|s| s == &e.service))
        .map(|e| (e.service.clone(), e.state.clone()))
        .collect();
    let mut machines: Vec<Machine> = entries
        .into_iter()
        .filter(|e| e.state == "running")
        .map(|e| {
            let ports = tcp_ports(&e.publishers);
            let interfaces = ifaces.remove(&e.name).unwrap_or_default();
            let ip = interfaces.first().map(|i| i.ip.clone()).unwrap_or_default();
            // A running container that fails its compose healthcheck is surfaced as unhealthy,
            // so the UI greys it like a dead one instead of showing a broken lab as fine.
            let state = if e.health == "unhealthy" { "unhealthy".to_string() } else { e.state };
            Machine { name: e.service, state, image: e.image, ip, ports, interfaces }
        })
        .collect();
    for (service, state) in down {
        if !machines.iter().any(|m| m.name == service) {
            machines.push(Machine { name: service, state, image: String::new(), ip: String::new(), ports: Vec::new(), interfaces: Vec::new() });
        }
    }
    Ok(LabStatus { running, machines, networks, url, host: None, expires_at: None })
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
    use super::{first_published_url, host_ports_from_config, parse_ifaces, parse_networks, parse_ps, tcp_ports};

    #[test]
    fn reads_published_host_ports_from_config() {
        let json = r#"{"services":{"web":{"ports":[{"published":"3206","target":3206}]},"db":{"ports":[{"published":3207,"target":3207}]},"init":{}}}"#;
        let mut ports = host_ports_from_config(json);
        ports.sort();
        assert_eq!(ports, vec![3206, 3207]);
        assert!(host_ports_from_config("{}").is_empty());
    }

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

    #[test]
    fn open_url_prefers_web_and_skips_datastores() {
        // Web port is numerically higher than the DB's: still pick the web service.
        let out = r#"[
          {"Service":"database","Image":"mysql:8.0","State":"running","Publishers":[{"PublishedPort":3207,"Protocol":"tcp"}]},
          {"Service":"web","Image":"invoice_web","State":"running","Publishers":[{"PublishedPort":3206,"Protocol":"tcp"}]}
        ]"#;
        assert_eq!(first_published_url(&parse_ps(out)).as_deref(), Some("http://127.0.0.1:3206"));
        // Web has exited; only the database is up. Don't point Open at the DB.
        let db_only = r#"[{"Service":"database","Image":"mysql:8.0","State":"running","Publishers":[{"PublishedPort":3207,"Protocol":"tcp"}]},
          {"Service":"web","State":"exited","Publishers":[]}]"#;
        assert_eq!(first_published_url(&parse_ps(db_only)), None);
    }

    #[test]
    fn reads_every_interface_with_the_lab_network_name() {
        let out = "/cyberctf-sqli-web-1\tcyberctf-sqli_dmz=172.21.0.3 cyberctf-sqli_internal=172.22.0.2 \n/cyberctf-sqli-db-1\tcyberctf-sqli_internal=172.22.0.3 \n/x\tcyberctf-sqli_dmz= \n";
        let m = parse_ifaces("sqli", out);
        let web: Vec<(&str, &str)> = m["cyberctf-sqli-web-1"].iter().map(|i| (i.network.as_str(), i.ip.as_str())).collect();
        assert_eq!(web, vec![("dmz", "172.21.0.3"), ("internal", "172.22.0.2")]);
        assert_eq!(m["cyberctf-sqli-db-1"][0].network, "internal");
        assert!(m["x"].is_empty(), "a network with no address yet is skipped");
    }

    #[test]
    fn reads_networks_preferring_ipv4_subnets() {
        let out = "cyberctf-sqli_internal\tfd00::/64 172.22.0.0/16 \ttrue\ncyberctf-sqli_default\t172.21.0.0/16 \tfalse\n";
        let n = parse_networks("sqli", out);
        assert_eq!(n.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), vec!["default", "internal"]);
        assert_eq!(n[1].subnet, "172.22.0.0/16");
        assert!(n[1].internal && !n[0].internal);
    }

    #[test]
    fn lists_a_port_published_on_ipv4_and_ipv6_once() {
        let out = r#"[{"Service":"db","State":"running","Publishers":[
          {"URL":"0.0.0.0","TargetPort":3207,"PublishedPort":3207,"Protocol":"tcp"},
          {"URL":"::","TargetPort":3207,"PublishedPort":3207,"Protocol":"tcp"},
          {"URL":"","TargetPort":33060,"PublishedPort":0,"Protocol":"tcp"}]}]"#;
        let ports = tcp_ports(&parse_ps(out)[0].publishers);
        assert_eq!(ports.iter().map(|p| (p.published, p.target)).collect::<Vec<_>>(), vec![(3207, 3207), (0, 33060)]);
    }
}
