//! The attack box: the learner's offensive container. It runs on its OWN network
//! (the "attack network") and is then connected into the lab's network, so the
//! attacker sits on a distinct segment yet can reach the targets. One per lab.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::exec::{run, stream};

fn container(id: &str) -> String {
    format!("cyberctf-{id}-attacker")
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
    let attack_net = format!("cyberctf-{id}-attack");
    // Report the attacker's address on its OWN network (distinct from the lab subnet).
    let tmpl = format!("{{{{.State.Running}}}}\t{{{{with index .NetworkSettings.Networks \"{attack_net}\"}}}}{{{{.IPAddress}}}}{{{{end}}}}");
    let probe = run("docker", &["inspect", "-f", &tmpl, &name], None).await;
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
    let lab_net = lab_network(id)
        .await
        .ok_or_else(|| Error::Invalid("the lab network isn't up — start the lab first".into()))?;
    let attack_net = format!("cyberctf-{id}-attack");
    // Own network first, then join the lab network: a distinct attack segment that can
    // still reach the targets (so the attacker is not on the same subnet as the lab).
    let _ = run("docker", &["network", "create", &attack_net], None).await;
    // Clear any previous attack box so a re-launch is clean.
    let _ = run("docker", &["rm", "-f", &name], None).await;
    log(format!("Starting the attack box on {attack_net}…"));
    stream(
        "docker",
        &["run", "-d", "--name", &name, "--network", &attack_net, "--hostname", "attacker", "--cap-add", "NET_ADMIN", image, "sleep", "infinity"],
        None,
        &[],
        &mut log,
    )
    .await?;
    log(format!("Connecting to the lab network {lab_net}…"));
    run("docker", &["network", "connect", &lab_net, &name], None).await?;
    log("✓ Attack box ready — open a shell to start.".into());
    Ok(())
}

pub async fn stop(id: &str, mut log: impl FnMut(String)) -> Result<()> {
    log("Removing the attack box…".into());
    let _ = stream("docker", &["rm", "-f", &container(id)], None, &[], &mut log).await;
    let _ = run("docker", &["network", "rm", &format!("cyberctf-{id}-attack")], None).await;
    Ok(())
}

/// Opens the player's own terminal attached to the attack box.
pub fn shell(id: &str) -> Result<()> {
    let name = container(id);
    // bash is present on Kali/Parrot/Exegol alike (keeps native-terminal quoting simple).
    #[cfg(target_os = "macos")]
    {
        // do script opens a new window; then give it a clean title instead of the raw command.
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"docker exec -it {name} bash\"\nset custom title of front window to \"CyberCTF attack box\"\nend tell"
        );
        std::process::Command::new("osascript").arg("-e").arg(script).spawn()?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/c", "start", "CyberCTF attack box", "cmd", "/k", &format!("docker exec -it {name} bash")]).spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let attach = format!("docker exec -it {name} bash");
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if std::process::Command::new(term).args(["-e", "sh", "-c", &attach]).spawn().is_ok() {
                return Ok(());
            }
        }
        Err(Error::Invalid(format!("couldn't open a terminal; run this yourself: {attach}")))
    }
}
