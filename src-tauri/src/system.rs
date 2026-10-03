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

/// Live machine health, polled by the Machine screen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineMetrics {
    /// Overall CPU usage, 0-100.
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub uptime_secs: u64,
    pub cores: usize,
    /// Running Docker containers right now (0 when the engine is down).
    pub containers: u32,
}

#[tauri::command]
pub async fn machine_metrics() -> MachineMetrics {
    use std::path::Path;
    use std::time::Duration;
    use sysinfo::{Disks, System};

    let mut sys = System::new();
    // CPU usage needs two samples a moment apart.
    sys.refresh_cpu_usage();
    tokio::time::sleep(Duration::from_millis(220)).await;
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu = sys.global_cpu_usage();
    let cores = sys.cpus().len();
    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();

    let disks = Disks::new_with_refreshed_list();
    let (disk_total, disk_avail) = disks
        .iter()
        .find(|d| d.mount_point() == Path::new("/"))
        .or_else(|| disks.iter().max_by_key(|d| d.total_space()))
        .map(|d| (d.total_space(), d.available_space()))
        .unwrap_or((0, 0));
    let disk_used = disk_total.saturating_sub(disk_avail);

    let containers = run("docker", &["ps", "--format", "{{.ID}}"], None)
        .await
        .ok()
        .map(|o| o.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);

    MachineMetrics {
        cpu,
        mem_used,
        mem_total,
        disk_used,
        disk_total,
        uptime_secs: System::uptime(),
        cores,
        containers,
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
