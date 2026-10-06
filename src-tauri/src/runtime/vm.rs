use std::path::Path;

use super::providers::Provider;
use super::{LabStatus, Machine};
use crate::error::Result;
use crate::exec::{run_env_timed, stream};

/// A status read must never hang the status poll: a wedged VirtualBox (its global lock held by
/// a stuck VBoxManage) would otherwise pile up one blocked `vagrant status` per poll tick.
const STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// `env` reaches the Vagrantfile and its provisioners (e.g. the evidence claim).
pub async fn start(dir: &Path, provider: Provider, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    stream("vagrant", &["up", "--provider", provider.id()], Some(dir), env, log).await
}

/// Destroys the VMs so the next start restores the lab's initial state. `env` must carry
/// the same server connection as `start`: Vagrant re-evaluates the Vagrantfile.
pub async fn stop(dir: &Path, env: &[(String, String)], log: impl FnMut(String)) -> Result<()> {
    stream("vagrant", &["destroy", "--force"], Some(dir), env, log).await
}

// `vagrant status --machine-readable` lines: timestamp,target,type,data...
fn parse_status(out: &str) -> Vec<Machine> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, ',');
            let (_ts, target, kind, data) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
            (kind == "state" && !target.is_empty()).then(|| Machine {
                name: target.to_string(),
                state: data.to_string(),
                image: String::new(),
                ip: String::new(),
                ports: Vec::new(),
                interfaces: Vec::new(),
                services: Vec::new(),
            })
        })
        .collect()
}

pub async fn status(dir: &Path, env: &[(String, String)]) -> Result<LabStatus> {
    let out = run_env_timed("vagrant", &["status", "--machine-readable"], Some(dir), env, STATUS_TIMEOUT).await?;
    let machines = parse_status(&out);
    let running = !machines.is_empty() && machines.iter().all(|m| m.state == "running");
    Ok(LabStatus { running, machines, networks: Vec::new(), url: None, host: None, expires_at: None, place: None })
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    #[test]
    fn parses_machine_readable_status() {
        let out = "1700000000,pfsense-1,metadata,provider,virtualbox\n\
                   1700000000,pfsense-1,state,running\n\
                   1700000000,debian-1,state,poweroff\n\
                   1700000000,,ui,info,Current machine states:\n";
        let machines = parse_status(out);
        assert_eq!(machines.len(), 2);
        assert_eq!(machines[0].name, "pfsense-1");
        assert_eq!(machines[1].state, "poweroff");
    }

    #[test]
    fn keeps_every_state_label_verbatim() {
        // Vagrant reports many lifecycle states; each is surfaced as-is for the UI.
        let out = "ts,a,state,saved\n\
                   ts,b,state,aborted\n\
                   ts,c,state,not_created\n\
                   ts,d,state,running\n";
        let m = parse_status(out);
        let states: Vec<(&str, &str)> = m.iter().map(|m| (m.name.as_str(), m.state.as_str())).collect();
        assert_eq!(states, vec![("a", "saved"), ("b", "aborted"), ("c", "not_created"), ("d", "running")]);
    }

    #[test]
    fn running_requires_every_machine_up() {
        // The `status()` running rule: all machines must be "running".
        let up = parse_status("ts,a,state,running\nts,b,state,running\n");
        assert!(!up.is_empty() && up.iter().all(|m| m.state == "running"));
        let mixed = parse_status("ts,a,state,running\nts,b,state,poweroff\n");
        assert!(!mixed.iter().all(|m| m.state == "running"));
    }

    #[test]
    fn ignores_non_state_lines_and_empty_or_malformed_output() {
        // Only `state` rows with a non-empty target become machines.
        let out = "ts,,ui,info,Current machine states:\n\
                   ts,box,metadata,provider,virtualbox\n\
                   ts,,state,running\n\
                   short,line\n";
        assert!(parse_status(out).is_empty());
        assert!(parse_status("").is_empty());
    }
}
