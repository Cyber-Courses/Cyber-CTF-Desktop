use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{Error, Result};
use crate::exec::{run, run_read};
use crate::runtime::providers::{self, ProviderStatus};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub installed: bool,
    pub version: Option<String>,
}

/// The OS package manager our one-click installs rely on (brew / winget / apt).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PkgManager {
    pub name: String,
    pub installed: bool,
    /// First line of its version output, e.g. "Homebrew 4.6.3", when installed.
    pub version: Option<String>,
}

/// Cloud provider CLIs, for the Cloud setup (AWS / Azure / GCP).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudClis {
    pub aws: Tool,
    pub azure: Tool,
    pub gcloud: Tool,
}

async fn package_manager() -> PkgManager {
    let name = if cfg!(target_os = "windows") {
        "winget"
    } else if cfg!(target_os = "linux") {
        "apt"
    } else {
        "Homebrew"
    };
    let version = {
        #[cfg(target_os = "macos")]
        {
            let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().find(|p| std::path::Path::new(p).exists());
            match brew {
                Some(b) => Some(
                    tokio::process::Command::new(b).arg("--version").output().await.ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default(),
                ),
                None => None,
            }
        }
        #[cfg(target_os = "windows")]
        {
            run("winget", &["--version"], None).await.ok()
        }
        #[cfg(target_os = "linux")]
        {
            run("apt-get", &["--version"], None).await.ok()
        }
    };
    let installed = version.is_some();
    let version = version.and_then(|v| v.lines().next().map(|l| l.trim().to_string())).filter(|v| !v.is_empty());
    PkgManager { name: name.to_string(), installed, version }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemReport {
    pub os: &'static str,
    pub arch: &'static str,
    pub pkg_manager: PkgManager,
    pub docker: Tool,
    /// The Docker daemon answers (Docker Desktop / engine is started).
    pub docker_running: bool,
    /// Which Docker-compatible engine answers, when one does: `docker-desktop`, `orbstack`,
    /// `colima`, `rancher-desktop`, `podman` or `docker-engine`.
    pub docker_engine: Option<&'static str>,
    /// Every engine whose Docker context answers right now. Several can run side by side
    /// (e.g. Docker Desktop and OrbStack); `docker_engine` is the one the CLI uses.
    pub docker_engines_running: Vec<&'static str>,
    pub docker_compose: Tool,
    pub vagrant: Tool,
    /// A local terraform binary (preferred for provisioning state; container is the fallback).
    pub terraform: Tool,
    /// VMware's OVF Tool, which the ESXi Vagrant plugin uses to upload VMs (ships with
    /// VMware Fusion / Workstation, or standalone from Broadcom).
    pub ovftool: Tool,
    pub cloud_clis: CloudClis,
    /// Vagrant providers (local hypervisors and remote hosts such as ESXi).
    /// Whether a given VM lab can run also depends on its boxes existing for
    /// this architecture: x86-only boxes (e.g. pfSense) cannot run on ARM hosts
    /// with a local hypervisor, but can on a remote x86 host.
    pub vm_providers: Vec<ProviderStatus>,
    /// What Isoloom says this machine can run, target by target (`isoloom targets --host`):
    /// the tools and credentials each one needs, found or missing.
    pub targets: Vec<TargetReadiness>,
}

/// One Isoloom target on this machine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetReadiness {
    /// The target id: `docker`, `vagrant`, `proxmox`, `cloud-vm`, ...
    pub target: String,
    /// The cloud, for the cloud targets (`aws`, `azure`, ...).
    pub cloud: Option<String>,
    pub ready: bool,
    /// One line: what was found, or what is missing.
    pub summary: String,
    /// Each thing found (plain) or missing (starts with `!`).
    pub notes: Vec<String>,
}

/// Isoloom's own view of the host, off the async runtime (it runs the tools).
async fn isoloom_targets() -> Vec<TargetReadiness> {
    tokio::task::spawn_blocking(|| {
        isoloom_core::host::all()
            .into_iter()
            .map(|r| TargetReadiness {
                target: r.target.id().to_string(),
                cloud: r.cloud.clone(),
                ready: r.ready,
                summary: r.summary(),
                notes: r.notes.clone(),
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Name the running engine from the daemon's OS string and the active CLI context.
async fn docker_engine(os: &str) -> &'static str {
    let context = run("docker", &["context", "show"], None).await.unwrap_or_default().to_lowercase();
    let os = os.to_lowercase();
    if os.contains("orbstack") || context.contains("orbstack") {
        "orbstack"
    } else if context.contains("colima") {
        "colima"
    } else if os.contains("rancher") || context.contains("rancher") {
        "rancher-desktop"
    } else if os.contains("podman") || context.contains("podman") {
        "podman"
    } else if os.contains("docker desktop") || context.starts_with("desktop-") {
        "docker-desktop"
    } else {
        "docker-engine"
    }
}

/// The engine behind a Docker CLI context, by the names the engines give their contexts.
/// `default` only counts on Linux, where it is the native daemon; elsewhere its socket is a
/// link to whichever desktop app installed it, so it says nothing on its own.
fn context_engine(name: &str, os: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n == "orbstack" {
        Some("orbstack")
    } else if n.starts_with("desktop-") {
        Some("docker-desktop")
    } else if n == "colima" || n.starts_with("colima-") {
        Some("colima")
    } else if n == "rancher-desktop" {
        Some("rancher-desktop")
    } else if n.starts_with("podman") {
        Some("podman")
    } else if n == "default" && os == "linux" {
        Some("docker-engine")
    } else {
        None
    }
}

/// The Docker CLI contexts, each with the engine behind it (unknown contexts are left out).
async fn engine_contexts() -> Vec<(String, &'static str)> {
    let out = run("docker", &["context", "ls", "--format", "{{.Name}}"], None).await.unwrap_or_default();
    out.lines().map(|l| l.trim().trim_end_matches(" *").to_string()).filter_map(|name| context_engine(&name, std::env::consts::OS).map(|e| (name, e))).collect()
}

/// Engines whose context answers, probed one by one (a stopped engine fails fast; the
/// timeout covers one that hangs).
async fn running_engines() -> Vec<&'static str> {
    let mut running = Vec::new();
    for (name, engine) in engine_contexts().await {
        let args = ["--context", name.as_str(), "version", "--format", "{{.Server.Version}}"];
        let probe = run("docker", &args, None);
        if matches!(tokio::time::timeout(std::time::Duration::from_secs(4), probe).await, Ok(Ok(_))) && !running.contains(&engine) {
            running.push(engine);
        }
    }
    running
}

/// Points the Docker CLI at another running engine (`docker context use`), as the player
/// would in a terminal. Labs then run on it.
#[tauri::command]
pub async fn docker_use_engine(engine: String) -> Result<()> {
    let name = engine_contexts()
        .await
        .into_iter()
        .find(|(_, e)| *e == engine)
        .map(|(name, _)| name)
        .ok_or_else(|| Error::Invalid(format!("no Docker context for {engine}")))?;
    run("docker", &["context", "use", &name], None).await?;
    Ok(())
}

async fn probe(program: &'static str, args: &[&str]) -> Tool {
    match run(program, args, None).await {
        Ok(out) => Tool { installed: true, version: out.lines().next().map(|l| l.trim().to_string()) },
        Err(_) => Tool { installed: false, version: None },
    }
}

#[tauri::command]
pub async fn system_check() -> SystemReport {
    let (docker, docker_compose, vagrant, daemon, aws, azure, gcloud, terraform) = tokio::join!(
        probe("docker", &["--version"]),
        probe("docker", &["compose", "version", "--short"]),
        probe("vagrant", &["--version"]),
        run_read("docker", &["info", "--format", "{{.OperatingSystem}}"], None),
        probe("aws", &["--version"]),
        // `az version` prints JSON (first line is "{"); ask for just the azure-cli version string.
        probe("az", &["version", "--query", "\"azure-cli\"", "--output", "tsv"]),
        probe("gcloud", &["--version"]),
        probe("terraform", &["version"]),
    );
    let (vm_providers, docker_engines_running, ovftool, targets) =
        tokio::join!(providers::detect(vagrant.installed), running_engines(), probe("ovftool", &["--version"]), isoloom_targets());
    let docker_engine = match &daemon {
        Ok(os) => Some(docker_engine(os.trim()).await),
        Err(_) => None,
    };
    SystemReport {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        pkg_manager: package_manager().await,
        docker,
        docker_running: daemon.is_ok(),
        docker_engine,
        docker_engines_running,
        docker_compose,
        vagrant,
        terraform,
        ovftool,
        cloud_clis: CloudClis { aws, azure, gcloud },
        vm_providers,
        targets,
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

    let containers =
        run_read("docker", &["ps", "--format", "{{.ID}}"], None).await.ok().map(|o| o.lines().filter(|l| !l.trim().is_empty()).count() as u32).unwrap_or(0);

    MachineMetrics { cpu, mem_used, mem_total, disk_used, disk_total, uptime_secs: System::uptime(), cores, containers }
}

/// Opens the guided "set up this machine" flow in its own window (label `machine-setup`),
/// mirroring the server setup window. Focuses it if already open.
#[tauri::command]
pub async fn machine_open_setup(app: AppHandle, step: Option<String>) -> Result<()> {
    const LABEL: &str = "machine-setup";
    // Only known step names reach the URL / the window.
    let step = step.filter(|s| matches!(s.as_str(), "pkgmgr" | "virtualization" | "docker" | "docker-test" | "attack" | "vm" | "vagrant" | "vm-test"));
    if let Some(existing) = app.get_webview_window(LABEL) {
        if let Some(step) = &step {
            let _ = existing.emit("machine-setup-step", step);
        }
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = match &step {
        Some(s) => format!("machine-setup?step={s}"),
        None => "machine-setup".to_string(),
    };
    let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("Set up this machine")
        // Tall enough for the longest step (the attack-machine toolset choice pushed its buttons
        // below the fold at 760), clamped to the screen so it never opens off-screen; the body
        // scrolls if a step is still taller. The minimum keeps a shrunk window usable.
        .inner_size(760.0, crate::window_height_fitting(&app, 920.0))
        .min_inner_size(640.0, crate::window_height_fitting(&app, 760.0))
        .resizable(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| Error::Invalid(e.to_string()))?;
    }
    builder.build().map_err(|e| Error::Invalid(format!("could not open the setup window: {e}")))?;
    Ok(())
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
