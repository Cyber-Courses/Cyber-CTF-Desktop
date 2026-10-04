//! Setup self-tests: prove this machine can actually run labs, not just that the tools exist.
//!
//! - `docker`: a throwaway two-container lab (busybox, ~2 MB). It checks the engine answers,
//!   an image pulls, compose starts the lab, containers reach each other by name on the lab
//!   network, and a published port is reachable from this machine. Always cleaned up.
//! - `vm`: a real throwaway VM on the first usable local hypervisor. It checks the
//!   hypervisor answers, gets a small test box (once, then cached), boots it on a private
//!   lab network, runs a command inside it, pings it from this machine, then destroys it.
//!
//! Progress goes to the UI as one event per step: `running`, then `ok` or `fail`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::exec::{run, stream};
use crate::runtime::providers::{self, Provider};

const PROJECT: &str = "cyberctf-selftest";
pub(crate) const IMAGE: &str = "busybox:1.36";
const MARKER: &str = "cyberctf-selftest-ok";

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Docker,
    Vm,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub step: &'static str,
    pub label: &'static str,
    /// `running`, `ok`, `fail` or `skip`.
    pub state: &'static str,
    pub detail: Option<String>,
}

struct Reporter(Channel<Event>);

impl Reporter {
    /// Live output for a step that is still running (shown as its detail line).
    fn progress(&self, step: &'static str, label: &'static str, line: String) {
        let line = line.trim();
        if !line.is_empty() {
            self.send(step, label, "running", Some(line.chars().take(160).collect()));
        }
    }

    fn send(&self, step: &'static str, label: &'static str, state: &'static str, detail: Option<String>) {
        let _ = self.0.send(Event { step, label, state, detail });
    }

    /// Runs one step, reporting it; a failure stops the test with that step's error.
    async fn step<T>(&self, step: &'static str, label: &'static str, fut: impl std::future::Future<Output = Result<(T, Option<String>)>>) -> Result<T> {
        self.send(step, label, "running", None);
        match fut.await {
            Ok((v, detail)) => {
                self.send(step, label, "ok", detail);
                Ok(v)
            }
            Err(e) => {
                self.send(step, label, "fail", Some(e.to_string()));
                Err(e)
            }
        }
    }
}

pub(crate) fn work_dir(app: &AppHandle, kind: &str) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("selftest").join(kind);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

// ---------- Background downloads ----------
//
// Setup starts the test downloads as soon as it opens (`machine_selftest_prefetch`), so by
// the time a test runs its image/box is usually there. A download in flight is marked busy;
// a test that needs it waits for it instead of starting a second one.

static DOCKER_DL: AtomicBool = AtomicBool::new(false);
static VM_DL: AtomicBool = AtomicBool::new(false);
/// Last line of the VM box download, so a test waiting on it can show progress.
static VM_DL_LINE: Mutex<String> = Mutex::new(String::new());

/// Holds a download flag; releases it when dropped (also on error).
struct Busy(&'static AtomicBool);
impl Busy {
    fn try_take(flag: &'static AtomicBool) -> Option<Busy> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok().map(|_| Busy(flag))
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Makes sure the test image is local. Returns whether it already was (or a background
/// download finished it) rather than being pulled now.
async fn ensure_image() -> Result<bool> {
    let mut waited = false;
    loop {
        if run("docker", &["image", "inspect", IMAGE], None).await.is_ok() {
            return Ok(true);
        }
        if let Some(_busy) = Busy::try_take(&DOCKER_DL) {
            run("docker", &["pull", "-q", IMAGE], None).await?;
            return Ok(waited);
        }
        waited = true;
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// Makes sure the test box is local. `on_line` sees download progress, including from a
/// background download this call is waiting on. Returns whether it was already there.
async fn ensure_box(dir: &Path, p: Provider, bx: &'static str, arm: bool, mut on_line: impl FnMut(String)) -> Result<bool> {
    let mut waited = false;
    loop {
        if pick_box(p, arm).await == (bx, true) {
            return Ok(true);
        }
        if let Some(_busy) = Busy::try_take(&VM_DL) {
            on_line(format!("Downloading {bx} for {}, once…", p.id()));
            stream("vagrant", &["box", "add", bx, "--provider", p.id(), "--force"], Some(dir), &[], |l| {
                if let Ok(mut last) = VM_DL_LINE.lock() {
                    last.clone_from(&l);
                }
                on_line(l);
            })
            .await?;
            return Ok(waited);
        }
        waited = true;
        let line = VM_DL_LINE.lock().map(|l| l.clone()).unwrap_or_default();
        on_line(if line.trim().is_empty() { format!("Finishing the background download of {bx}…") } else { line });
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// The local provider the VM test uses: the preferred one (Settings) when it's ready,
/// else the first one whose hypervisor and plugin are ready.
async fn test_provider(preferred: Option<Provider>) -> Option<Provider> {
    let ready: Vec<Provider> =
        providers::detect(true).await.iter().filter(|s| !s.remote && s.available && s.hypervisor != Some(false)).map(|s| s.provider).collect();
    preferred.filter(|p| ready.contains(p)).or_else(|| ready.first().copied())
}

/// Starts the test downloads early (called when setup opens). Errors are ignored by the UI:
/// the test itself retries and reports them.
#[tauri::command]
pub async fn machine_selftest_prefetch(app: AppHandle, kind: Kind, provider: Option<Provider>) -> Result<()> {
    match kind {
        Kind::Docker => ensure_image().await.map(|_| ()),
        Kind::Vm => {
            let Some(p) = test_provider(provider).await else { return Ok(()) };
            let arm = std::env::consts::ARCH == "aarch64";
            let (bx, cached) = pick_box(p, arm).await;
            if cached {
                return Ok(());
            }
            ensure_box(&work_dir(&app, "vm")?, p, bx, arm, |_| {}).await.map(|_| ())
        }
    }
}

#[tauri::command]
pub async fn machine_selftest(app: AppHandle, kind: Kind, provider: Option<Provider>, events: Channel<Event>) -> Result<()> {
    let r = Reporter(events);
    match kind {
        Kind::Docker => docker(&work_dir(&app, "docker")?, &r).await,
        Kind::Vm => vm(&work_dir(&app, "vm")?, provider, &r).await,
    }
}

// ---------- Docker ----------

fn compose_file() -> String {
    format!(
        r#"services:
  web:
    image: {IMAGE}
    command: ["sh", "-c", "mkdir -p /www && echo {MARKER} > /www/index.html && httpd -f -p 80 -h /www"]
    ports: ["127.0.0.1::80"]
  probe:
    image: {IMAGE}
    command: ["sleep", "300"]
"#
    )
}

async fn compose(dir: &Path, rest: &[&str]) -> Result<String> {
    let mut args = vec!["compose", "-p", PROJECT, "-f", "docker-compose.yml"];
    args.extend_from_slice(rest);
    run("docker", &args, Some(dir)).await
}

async fn docker(dir: &Path, r: &Reporter) -> Result<()> {
    std::fs::write(dir.join("docker-compose.yml"), compose_file())?;
    let res = docker_steps(dir, r).await;
    // Always tear the test lab down, even after a failed step.
    let down = compose(dir, &["down", "-v", "--remove-orphans", "-t", "0"]).await;
    match (&res, down) {
        (Ok(()), Ok(_)) => r.send("cleanup", "Clean up", "ok", None),
        (Ok(()), Err(e)) => r.send("cleanup", "Clean up", "fail", Some(e.to_string())),
        (Err(_), _) => {}
    }
    res
}

async fn docker_steps(dir: &Path, r: &Reporter) -> Result<()> {
    r.step("engine", "Container engine answers", async {
        let v = run("docker", &["info", "--format", "{{.ServerVersion}}"], None).await?;
        Ok(((), Some(format!("Docker {}", v.trim()))))
    })
    .await?;

    r.step("pull", "Download a test image", async {
        let had = ensure_image().await?;
        Ok(((), Some(if had { format!("{IMAGE} (ready)") } else { IMAGE.to_string() })))
    })
    .await?;

    r.step("start", "Start a two-container test lab", async {
        compose(dir, &["up", "-d", "--quiet-pull"]).await?;
        Ok(((), None))
    })
    .await?;

    r.step("network", "Containers reach each other", async {
        // httpd needs a moment; retry briefly.
        let mut last = String::new();
        for _ in 0..10 {
            match compose(dir, &["exec", "-T", "probe", "wget", "-qO-", "-T", "2", "http://web"]).await {
                Ok(out) if out.contains(MARKER) => return Ok(((), Some("probe → web on the lab network".into()))),
                Ok(out) => last = out,
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(Error::Invalid(format!("probe could not reach web: {last}")))
    })
    .await?;

    r.step("port", "Lab port reachable from this machine", async {
        let addr = compose(dir, &["port", "web", "80"]).await?;
        let url = format!("http://{}", addr.trim());
        let client = reqwest::Client::builder().timeout(Duration::from_secs(3)).build().map_err(|e| Error::Invalid(e.to_string()))?;
        let mut last = String::new();
        for _ in 0..10 {
            match client.get(&url).send().await {
                Ok(res) => match res.text().await {
                    Ok(body) if body.contains(MARKER) => return Ok(((), Some(addr.trim().to_string()))),
                    Ok(body) => last = body,
                    Err(e) => last = e.to_string(),
                },
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(Error::Invalid(format!("{url} did not answer: {last}")))
    })
    .await?;

    Ok(())
}

// ---------- VMs ----------

/// The test VM's address on its private lab network (VirtualBox's default host-only range).
const VM_IP: &str = "192.168.56.250";
/// How the test VM shows up in the hypervisor's own app while it runs.
const VM_NAME: &str = "CyberCTF test VM";

/// A read-only command that only succeeds when the hypervisor's service is up and usable
/// by this user (not just installed).
fn responds(p: Provider) -> Option<(&'static str, &'static [&'static str])> {
    match p {
        Provider::Virtualbox => Some(("VBoxManage", &["list", "hostinfo"])),
        Provider::VmwareDesktop => Some(("vmrun", &["list"])),
        Provider::Parallels => Some(("prlctl", &["list", "--all"])),
        Provider::Libvirt => Some(("virsh", &["-c", "qemu:///system", "list", "--all"])),
        Provider::Utm => Some(("/Applications/UTM.app/Contents/MacOS/utmctl", &["list"])),
        _ => None,
    }
}

/// Small public boxes that exist for this provider and CPU, smallest first.
pub(crate) fn candidate_boxes(p: Provider, arm: bool) -> &'static [&'static str] {
    match (p, arm) {
        (Provider::Virtualbox | Provider::VmwareDesktop | Provider::Parallels, false) => &["generic/alpine319", "bento/debian-12"],
        (Provider::Virtualbox | Provider::VmwareDesktop | Provider::Parallels, true) => &["bento/debian-12"],
        (Provider::Utm, _) => &["utm/bookworm"],
        _ => &["generic/alpine319"],
    }
}

/// Providers whose Vagrant plugin can put the VM on a static private network.
fn has_private_network(p: Provider) -> bool {
    matches!(p, Provider::Virtualbox | Provider::VmwareDesktop | Provider::Parallels | Provider::Libvirt)
}

/// Picks a candidate box already downloaded for this provider, else the first candidate.
/// Returns (box, already downloaded).
async fn pick_box(p: Provider, arm: bool) -> (&'static str, bool) {
    let candidates = candidate_boxes(p, arm);
    let arch = if arm { "arm64" } else { "amd64" };
    let list = run("vagrant", &["box", "list"], None).await.unwrap_or_default();
    // Lines look like: `bento/debian-12   (virtualbox, 202510.26.0, (amd64))`
    for c in candidates {
        let present = list.lines().any(|l| {
            let mut parts = l.splitn(2, char::is_whitespace);
            let name = parts.next().unwrap_or("");
            let rest = parts.next().unwrap_or("");
            name == *c && rest.contains(&format!("({},", p.id())) && (!rest.contains("(amd64)") && !rest.contains("(arm64)") || rest.contains(&format!("({arch})")))
        });
        if present {
            return (c, true);
        }
    }
    (candidates[0], false)
}

fn vagrantfile(p: Provider, bx: &str) -> String {
    let mut v = format!("Vagrant.configure(\"2\") do |config|\n  config.vm.box = \"{bx}\"\n  config.vm.hostname = \"cyberctf-selftest\"\n  config.vm.boot_timeout = 600\n  config.vm.synced_folder \".\", \"/vagrant\", disabled: true\n");
    if has_private_network(p) {
        v.push_str(&format!("  config.vm.network \"private_network\", ip: \"{VM_IP}\"\n"));
    }
    // A readable name in the hypervisor's VM list instead of Vagrant's `<dir>_default_<timestamp>`.
    let settings = match p {
        Provider::Virtualbox => format!("    h.name = \"{VM_NAME}\"\n    h.memory = 512\n"),
        Provider::VmwareDesktop => format!("    h.vmx[\"displayName\"] = \"{VM_NAME}\"\n    h.memory = 512\n"),
        Provider::Parallels => format!("    h.name = \"{VM_NAME}\"\n    h.memory = 512\n"),
        Provider::Libvirt => "    h.default_prefix = \"cyberctf-\"\n    h.memory = 512\n".to_string(),
        Provider::Hyperv => format!("    h.vmname = \"{VM_NAME}\"\n"),
        Provider::Utm => format!("    h.name = \"{VM_NAME}\"\n"),
        _ => String::new(),
    };
    if !settings.is_empty() {
        v.push_str(&format!("  config.vm.provider \"{}\" do |h|\n{settings}  end\n", p.id()));
    }
    v.push_str("end\n");
    v
}

async fn ping(ip: &str) -> Result<String> {
    if cfg!(windows) {
        run("ping", &["-n", "1", "-w", "3000", ip], None).await
    } else if cfg!(target_os = "macos") {
        run("ping", &["-c", "1", "-t", "3", ip], None).await
    } else {
        run("ping", &["-c", "1", "-W", "3", ip], None).await
    }
}

async fn vm(dir: &Path, preferred: Option<Provider>, r: &Reporter) -> Result<()> {
    // A test interrupted last time (window closed) may have left its VM behind.
    if dir.join(".vagrant").exists() {
        let _ = run("vagrant", &["destroy", "-f"], Some(dir)).await;
    }
    let res = vm_steps(dir, preferred, r).await;
    // Destroy the VM whatever happened; the box stays cached for the next test.
    if dir.join("Vagrantfile").exists() {
        let down = run("vagrant", &["destroy", "-f"], Some(dir)).await;
        match (&res, down) {
            (Ok(()), Ok(_)) => r.send("cleanup", "Delete the test VM", "ok", Some("test box kept for next time".into())),
            (Ok(()), Err(e)) => r.send("cleanup", "Delete the test VM", "fail", Some(e.to_string())),
            (Err(_), _) => {}
        }
    }
    res
}

async fn vm_steps(dir: &Path, preferred: Option<Provider>, r: &Reporter) -> Result<()> {
    r.step("vagrant", "Vagrant is installed", async {
        let v = run("vagrant", &["--version"], None).await?;
        Ok(((), Some(v.trim().to_string())))
    })
    .await?;

    let provider = r
        .step("provider", "A hypervisor is ready", async {
            let p = test_provider(preferred).await.ok_or_else(|| Error::Invalid("no local hypervisor with its Vagrant plugin is installed".into()))?;
            Ok((p, Some(p.id().to_string())))
        })
        .await?;

    r.step("hypervisor", "Hypervisor responds", async {
        match responds(provider) {
            Some((program, args)) => {
                run(program, args, None).await?;
                Ok(((), None))
            }
            None => Ok(((), Some("nothing to probe for this provider".into()))),
        }
    })
    .await?;

    let arm = std::env::consts::ARCH == "aarch64";
    let (bx, _) = pick_box(provider, arm).await;
    r.step("box", "Get a small test VM image", async {
        let had = ensure_box(dir, provider, bx, arm, |l| r.progress("box", "Get a small test VM image", l)).await?;
        Ok(((), Some(if had { format!("{bx} (ready)") } else { bx.to_string() })))
    })
    .await?;

    r.step("boot", "Boot the test VM", async {
        std::fs::write(dir.join("Vagrantfile"), vagrantfile(provider, bx))?;
        stream("vagrant", &["up", "--provider", provider.id()], Some(dir), &[], |l| r.progress("boot", "Boot the test VM", l)).await?;
        Ok(((), Some(format!("{bx} on {}", provider.id()))))
    })
    .await?;

    r.step("exec", "Run a command inside the VM", async {
        let out = run("vagrant", &["ssh", "-c", "uname -srm"], Some(dir)).await?;
        Ok(((), Some(out.trim().to_string())))
    })
    .await?;

    if has_private_network(provider) {
        r.step("network", "VM reachable on a lab network", async {
            let mut last = String::new();
            for _ in 0..5 {
                match ping(VM_IP).await {
                    Ok(_) => return Ok(((), Some(format!("this machine → {VM_IP}")))),
                    Err(e) => last = e.to_string(),
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(Error::Invalid(format!("{VM_IP} did not answer ping: {last}")))
        })
        .await?;
    } else {
        r.send("network", "VM reachable on a lab network", "skip", Some(format!("{} has no private networks", provider.id())));
    }

    Ok(())
}
