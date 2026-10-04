//! Reading a running lab: its machines, their networks and addresses, the reachable URL.
//! `status()` is a thin composer; each signal (url, networks, interfaces, health) is its
//! own small function so features stop sharing one body.

use std::collections::HashMap;
use std::path::Path;

use super::compose::{self, PsEntry, Publisher};
use crate::error::Result;
use crate::exec::run;
use crate::runtime::{Interface, LabStatus, Machine, Network, Port, Service};

/// True for services that aren't a web UI (databases, caches, brokers): the Open button
/// must never point a browser at one.
fn is_datastore(e: &PsEntry) -> bool {
    let s = format!("{} {}", e.service, e.image).to_ascii_lowercase();
    ["mysql", "mariadb", "postgres", "redis", "mongo", "memcached", "rabbitmq", "elastic", "mssql", "oracle"].iter().any(|k| s.contains(k))
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
    name.strip_prefix(&format!("{}_", compose::project(id))).unwrap_or(name).to_string()
}

/// What `docker inspect` tells about one running container: its interfaces and the
/// services the lab declares in it.
#[derive(Default)]
struct Inspected {
    interfaces: Vec<Interface>,
    services: Vec<Service>,
}

/// Each running container's interfaces (network -> address) and declared services, keyed by
/// container name. `docker compose ps` carries neither addresses nor a parseable label map
/// (it joins labels with commas), so we inspect the live containers once.
/// Best effort: an empty map (e.g. inspect failed) just means the UI shows no IPs.
async fn inspect_containers(dir: &Path, id: &str, names: &[String]) -> HashMap<String, Inspected> {
    if names.is_empty() {
        return HashMap::new();
    }
    let mut args: Vec<&str> =
        vec!["inspect", "-f", "{{.Name}}\t{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}\t{{json .Config.Labels}}"];
    args.extend(names.iter().map(String::as_str));
    let out = match run("docker", &args, Some(dir)).await {
        Ok(out) => out,
        Err(_) => return HashMap::new(),
    };
    parse_inspect(id, &out)
}

fn parse_inspect(id: &str, out: &str) -> HashMap<String, Inspected> {
    out.lines()
        .filter_map(|line| {
            let mut cols = line.splitn(3, '\t');
            let name = cols.next()?;
            let interfaces = cols
                .next()
                .unwrap_or_default()
                .split_whitespace()
                .filter_map(|kv| kv.split_once('='))
                .filter(|(_, ip)| !ip.is_empty())
                .map(|(net, ip)| Interface { network: short_network(id, net), ip: ip.to_string() })
                .collect();
            let labels: HashMap<String, String> = cols.next().and_then(|j| serde_json::from_str(j).ok()).unwrap_or_default();
            Some((name.trim_start_matches('/').to_string(), Inspected { interfaces, services: declared_services(&labels) }))
        })
        .collect()
}

/// The services a lab declares on a container: `cyberctf.service.<name>: "<kind>:<ports>"`,
/// ports comma-separated and optional (`worker`). Malformed ports are skipped, never guessed.
fn declared_services(labels: &HashMap<String, String>) -> Vec<Service> {
    let mut services: Vec<Service> = labels
        .iter()
        .filter_map(|(k, v)| {
            let name = k.strip_prefix("cyberctf.service.")?.trim();
            let (kind, ports) = v.split_once(':').unwrap_or((v, ""));
            let ports = ports.split(',').filter_map(|p| p.trim().parse::<u16>().ok()).filter(|p| *p > 0).collect();
            (!name.is_empty()).then(|| Service { name: name.to_string(), kind: kind.trim().to_string(), ports })
        })
        .collect();
    services.sort_by(|a, b| a.name.cmp(&b.name));
    services
}

/// The lab's networks (Compose labels them with the project), with subnet and isolation.
async fn lab_networks(id: &str) -> Vec<Network> {
    let filter = format!("label=com.docker.compose.project={}", compose::project(id));
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

pub async fn status(dir: &Path, id: &str) -> Result<LabStatus> {
    let project = compose::project(id);
    let out = compose::output(dir, &project, &["ps", "--all", "--format", "json"]).await?;
    let entries = compose::parse_ps(&out);
    // Labs have one-shot init services (e.g. evidence, place-evidence) that exit 0 after
    // doing their job, so the lab is "running" when at least one service is up, not when
    // every service is. Only the live services are reported to the UI.
    let running = entries.iter().any(|e| e.state == "running");
    let url = if running { first_published_url(&entries) } else { None };
    let run_names: Vec<String> = entries.iter().filter(|e| e.state == "running").map(|e| e.name.clone()).collect();
    let mut inspected = inspect_containers(dir, id, &run_names).await;
    let networks = if running { lab_networks(id).await } else { Vec::new() };
    // Serving containers (those that publish a port) that should be up but aren't: a lab
    // whose web died is reported degraded, not fine. One-shot init jobs publish nothing, so
    // their normal exit is ignored. Config is only consulted while the lab is up.
    let serving = if running {
        compose::output(dir, &project, &["config", "--format", "json"]).await.ok().map(|c| compose::serving_services_from_config(&c)).unwrap_or_default()
    } else {
        Vec::new()
    };
    let down: Vec<(String, String)> =
        entries.iter().filter(|e| e.state != "running" && serving.iter().any(|s| s == &e.service)).map(|e| (e.service.clone(), e.state.clone())).collect();
    let mut machines: Vec<Machine> = entries
        .into_iter()
        .filter(|e| e.state == "running")
        .map(|e| {
            let ports = tcp_ports(&e.publishers);
            let Inspected { interfaces, services } = inspected.remove(&e.name).unwrap_or_default();
            let ip = interfaces.first().map(|i| i.ip.clone()).unwrap_or_default();
            // A running container that fails its compose healthcheck is surfaced as unhealthy,
            // so the UI greys it like a dead one instead of showing a broken lab as fine.
            let state = if e.health == "unhealthy" { "unhealthy".to_string() } else { e.state };
            Machine { name: e.service, state, image: e.image, ip, ports, interfaces, services }
        })
        .collect();
    for (service, state) in down {
        if !machines.iter().any(|m| m.name == service) {
            machines.push(Machine {
                name: service,
                state,
                image: String::new(),
                ip: String::new(),
                ports: Vec::new(),
                interfaces: Vec::new(),
                services: Vec::new(),
            });
        }
    }
    Ok(LabStatus { running, machines, networks, url, host: None, expires_at: None })
}

/// Where the lab is reachable on this machine (its first published port), once running.
pub async fn primary_url(dir: &Path, id: &str) -> Option<String> {
    let project = compose::project(id);
    let out = compose::output(dir, &project, &["ps", "--format", "json"]).await.ok()?;
    first_published_url(&compose::parse_ps(&out))
}

#[cfg(test)]
mod tests {
    use super::compose::parse_ps;
    use super::{declared_services, first_published_url, parse_inspect, parse_networks, tcp_ports};

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
        let m: std::collections::HashMap<_, _> = parse_inspect("sqli", out).into_iter().map(|(k, v)| (k, v.interfaces)).collect();
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

    #[test]
    fn reads_the_services_a_lab_declares_and_nothing_else() {
        let out = "/cyberctf-x-app-1\tcyberctf-x_default=172.20.0.2 \t{\"cyberctf.service.web\":\"web:80,443\",\"cyberctf.service.ssh\":\"ssh:22\",\"cyberctf.service.jobs\":\"worker\",\"com.docker.compose.service\":\"app\"}\n";
        let m = parse_inspect("x", out);
        let s = &m["cyberctf-x-app-1"].services;
        let got: Vec<(&str, &str, Vec<u16>)> = s.iter().map(|s| (s.name.as_str(), s.kind.as_str(), s.ports.clone())).collect();
        assert_eq!(got, vec![("jobs", "worker", vec![]), ("ssh", "ssh", vec![22]), ("web", "web", vec![80, 443])]);
        assert_eq!(m["cyberctf-x-app-1"].interfaces[0].ip, "172.20.0.2");
        // No labels, null labels: no services (never inferred).
        assert!(parse_inspect("x", "/a\t\tnull\n")["a"].services.is_empty());
        assert!(declared_services(&[("cyberctf.service.db".to_string(), "database:abc".to_string())].into()).first().unwrap().ports.is_empty());
    }
}
