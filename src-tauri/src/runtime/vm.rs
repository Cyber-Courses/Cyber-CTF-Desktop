use std::path::Path;

use super::providers::Provider;
use super::{LabStatus, Machine};
use crate::error::Result;
use crate::exec::{run_env, stream};

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
    let out = run_env("vagrant", &["status", "--machine-readable"], Some(dir), env).await?;
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
}
