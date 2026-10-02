use serde::Serialize;

use crate::exec::run;
use crate::runtime::providers::{self, ProviderStatus};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemReport {
    pub os: &'static str,
    pub arch: &'static str,
    pub docker: Tool,
    /// The Docker daemon answers (Docker Desktop / engine is started).
    pub docker_running: bool,
    pub docker_compose: Tool,
    pub vagrant: Tool,
    /// Vagrant providers (local hypervisors and remote hosts such as ESXi).
    /// Whether a given VM lab can run also depends on its boxes existing for
    /// this architecture: x86-only boxes (e.g. pfSense) cannot run on ARM hosts
    /// with a local hypervisor, but can on a remote x86 host.
    pub vm_providers: Vec<ProviderStatus>,
}

async fn probe(program: &'static str, args: &[&str]) -> Tool {
    match run(program, args, None).await {
        Ok(out) => Tool { installed: true, version: out.lines().next().map(|l| l.trim().to_string()) },
        Err(_) => Tool { installed: false, version: None },
    }
}

#[tauri::command]
pub async fn system_check() -> SystemReport {
    let (docker, docker_compose, vagrant, daemon) = tokio::join!(
        probe("docker", &["--version"]),
        probe("docker", &["compose", "version", "--short"]),
        probe("vagrant", &["--version"]),
        run("docker", &["info", "--format", "{{.ServerVersion}}"], None),
    );
    let vm_providers = providers::detect(vagrant.installed).await;
    SystemReport {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        docker,
        docker_running: daemon.is_ok(),
        docker_compose,
        vagrant,
        vm_providers,
    }
}

#[cfg(test)]
mod tests {
    /// Runs the real probes against this machine: `cargo test -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "depends on the host's installed tools"]
    async fn prints_this_machines_report() {
        let report = super::system_check().await;
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    }
}
