//! The attack box. Exegol is an offensive toolbox that we run as its own container
//! attached to a lab's Docker network, so the player's tools sit right next to the
//! targets. One attack box per lab (named after the lab's compose project).

use serde::Serialize;

use crate::error::{Error, Result};
use crate::exec::{run, stream};

fn container(id: &str) -> String {
    format!("cyberctf-{id}-exegol")
}

/// Guards an image reference so it can't be read as a flag or smuggle extra args.
/// (It's passed to docker without a shell, so this only blocks a leading `-` and
/// anything outside a normal `registry/name:tag@digest`.)
pub fn valid_image(image: &str) -> bool {
    !image.is_empty()
        && image.len() <= 200
        && !image.starts_with('-')
        && image.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '@'))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExegolStatus {
    /// The image is pulled locally (otherwise the first start downloads it, several GB).
    pub image_present: bool,
    pub running: bool,
    /// The attack box's address on the lab network, once running.
    pub ip: String,
    /// The command that attaches a shell (shown so the player can also run it anywhere).
    pub shell_cmd: String,
}

/// The lab's Docker network: Compose labels its networks with the project name.
async fn lab_network(id: &str) -> Option<String> {
    let filter = format!("label=com.docker.compose.project=cyberctf-{id}");
    let out = run("docker", &["network", "ls", "--filter", &filter, "--format", "{{.Name}}"], None).await.ok()?;
    out.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

pub async fn status(id: &str, image: &str) -> ExegolStatus {
    let image_present = run("docker", &["image", "inspect", image], None).await.is_ok();
    let name = container(id);
    let probe = run("docker", &["inspect", "-f", "{{.State.Running}}\t{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", &name], None).await;
    let (running, ip) = match probe {
        Ok(out) => {
            let line = out.lines().next().unwrap_or_default();
            let (r, rest) = line.split_once('\t').unwrap_or(("false", ""));
            (r.trim() == "true", rest.split_whitespace().next().unwrap_or_default().to_string())
        }
        Err(_) => (false, String::new()),
    };
    ExegolStatus { image_present, running, ip, shell_cmd: format!("docker exec -it {name} bash") }
}

pub async fn start(id: &str, image: &str, mut log: impl FnMut(String)) -> Result<()> {
    let name = container(id);
    if run("docker", &["image", "inspect", image], None).await.is_err() {
        log(format!("Pulling {image} — a large image, downloads only once…"));
        stream("docker", &["pull", image], None, &[], &mut log).await?;
    }
    let net = lab_network(id)
        .await
        .ok_or_else(|| Error::Invalid("the lab network isn't up — start the lab first".into()))?;
    // Clear any previous attack box so a re-launch is clean.
    let _ = run("docker", &["rm", "-f", &name], None).await;
    log(format!("Starting the attack box on {net}…"));
    stream(
        "docker",
        &["run", "-d", "--name", &name, "--network", &net, "--hostname", "exegol", "--cap-add", "NET_ADMIN", image, "sleep", "infinity"],
        None,
        &[],
        &mut log,
    )
    .await?;
    log("✓ Attack box ready — open a shell to start.".into());
    Ok(())
}

pub async fn stop(id: &str, mut log: impl FnMut(String)) -> Result<()> {
    log("Removing the attack box…".into());
    stream("docker", &["rm", "-f", &container(id)], None, &[], &mut log).await?;
    Ok(())
}

/// Opens the player's own terminal attached to the attack box.
pub fn shell(id: &str) -> Result<()> {
    let name = container(id);
    // bash is present on Kali/Parrot/Exegol alike (keeps native-terminal quoting simple).
    let attach = format!("docker exec -it {name} bash");
    #[cfg(target_os = "macos")]
    {
        let script = format!("tell application \"Terminal\"\nactivate\ndo script \"{attach}\"\nend tell");
        std::process::Command::new("osascript").arg("-e").arg(script).spawn()?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/c", "start", "cmd", "/k", &attach]).spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if std::process::Command::new(term).args(["-e", "sh", "-c", &attach]).spawn().is_ok() {
                return Ok(());
            }
        }
        Err(Error::Invalid(format!("couldn't open a terminal; run this yourself: {attach}")))
    }
}
