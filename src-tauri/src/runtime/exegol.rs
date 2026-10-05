//! The attack box: the learner's offensive container. It runs on its OWN network
//! (the "attack network") and is then connected into the lab's network, so the
//! attacker sits on a distinct segment yet can reach the targets. One per lab.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::exec::{run, run_read, stream};

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
    /// The attack box's address on the lab network (what the targets see), once running.
    pub ip: String,
    /// The lab network it is plugged into (the lab's name for it, e.g. "default"), once running.
    pub lab_network: String,
    /// The command that attaches a shell (shown so the player can also run it anywhere).
    pub shell_cmd: String,
}

/// The lab's Docker networks (Compose labels them with the project name), the main one
/// first: `<project>_default` when the lab has it, so the attack box's reported address
/// is the one most targets see.
async fn lab_networks(id: &str) -> Vec<String> {
    let filter = format!("label=com.docker.compose.project=cyberctf-{id}");
    let out = run_read("docker", &["network", "ls", "--filter", &filter, "--format", "{{.Name}}"], None).await.unwrap_or_default();
    main_first(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

fn main_first(mut networks: Vec<String>) -> Vec<String> {
    networks.sort();
    if let Some(i) = networks.iter().position(|n| n.ends_with("_default")) {
        let main = networks.remove(i);
        networks.insert(0, main);
    }
    networks
}

/// The main lab network.
async fn lab_network(id: &str) -> Option<String> {
    lab_networks(id).await.into_iter().next()
}

pub async fn status(id: &str, image: &str) -> ExegolStatus {
    let image_present = run_read("docker", &["image", "inspect", image], None).await.is_ok();
    let name = container(id);
    // Report the attacker's address on the lab network: the one the targets see it from.
    let lab_net = lab_network(id).await.unwrap_or_default();
    let tmpl = format!("{{{{.State.Running}}}}\t{{{{with index .NetworkSettings.Networks \"{lab_net}\"}}}}{{{{.IPAddress}}}}{{{{end}}}}");
    let probe = run_read("docker", &["inspect", "-f", &tmpl, &name], None).await;
    let (running, ip) = match probe {
        Ok(out) => {
            let line = out.lines().next().unwrap_or_default();
            let (r, rest) = line.split_once('\t').unwrap_or(("false", ""));
            (r.trim() == "true", rest.split_whitespace().next().unwrap_or_default().to_string())
        }
        Err(_) => (false, String::new()),
    };
    let lab_network = if running && !lab_net.is_empty() { super::docker::short_network(id, &lab_net) } else { String::new() };
    ExegolStatus { image_present, running, ip, lab_network, shell_cmd: format!("docker exec -it {name} bash") }
}

pub async fn start(id: &str, image: &str, mut log: impl FnMut(String)) -> Result<()> {
    let name = container(id);
    if run("docker", &["image", "inspect", image], None).await.is_err() {
        log(format!("Pulling {image} — a large image, downloads only once…"));
        stream("docker", &["pull", image], None, &[], &mut log).await?;
    }
    let lab_nets = lab_networks(id).await;
    if lab_nets.is_empty() {
        return Err(Error::Invalid("the lab network isn't up — start the lab first".into()));
    }
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
    // Every lab network, so labs with their own segments (dmz, internal...) are reachable.
    for lab_net in &lab_nets {
        log(format!("Connecting to the lab network {}…", super::docker::short_network(id, lab_net)));
        run("docker", &["network", "connect", lab_net, &name], None).await?;
    }
    log("✓ Attack box ready — open a shell to start.".into());
    Ok(())
}

/// Plugs a running attack box into every current lab network (a lab restarted, or updated to
/// a version with other networks, keeps the attack box but not its connections). Best effort.
pub async fn rejoin(id: &str) {
    let name = container(id);
    if !matches!(run_read("docker", &["inspect", "-f", "{{.State.Running}}", &name], None).await, Ok(o) if o.trim() == "true") {
        return;
    }
    for lab_net in lab_networks(id).await {
        // "already exists" when it's plugged in already: fine.
        let _ = run("docker", &["network", "connect", &lab_net, &name], None).await;
    }
}

pub async fn stop(id: &str, mut log: impl FnMut(String)) -> Result<()> {
    log("Removing the attack box…".into());
    let _ = stream("docker", &["rm", "-f", &container(id)], None, &[], &mut log).await;
    let _ = run("docker", &["network", "rm", &format!("cyberctf-{id}-attack")], None).await;
    Ok(())
}

/// Opens the player's own terminal attached to the attack box.
pub fn shell(id: &str) -> Result<()> {
    // bash is present on Kali/Parrot/Exegol alike (keeps native-terminal quoting simple).
    open_terminal(&format!("docker exec -it {} bash", container(id)))
}

/// Escapes text for an AppleScript double-quoted string.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn applescript_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Opens the OS terminal on `command` (a POSIX shell command line), titled
/// "Cyber CTF attack box". The command line itself never stays on screen: the window is
/// cleared first, and the command replaces the shell (exec), so leaving the box ends the
/// session. DOCKER_CLI_HINTS=false drops Docker's "What's next" ad on exit.
pub fn open_terminal(command: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // do script types the line into a new window; escape it for the AppleScript string.
        // The leading space keeps it out of shell history where HIST_IGNORE_SPACE is on.
        let line = applescript_string(&format!(" clear; DOCKER_CLI_HINTS=false exec {command}"));
        let script =
            format!("tell application \"Terminal\"\nactivate\ndo script \"{line}\"\nset custom title of front window to \"Cyber CTF attack box\"\nend tell");
        std::process::Command::new("osascript").arg("-e").arg(script).spawn()?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // cmd.exe's quote-stripping with nested quotes and `&` is unreliable (it breaks when the
        // identity/known_hosts path contains a space, e.g. C:\Users\First Last\...), so write the
        // command to a temp .cmd and run that: the ssh line lives in the file with normal
        // double-quoted paths, and the only thing cmd parses is the balanced-quoted .cmd path.
        let command = command.replace('\'', "\"");
        let bat = std::env::temp_dir().join(format!("cyberctf-shell-{}.cmd", std::process::id()));
        std::fs::write(&bat, format!("@echo off\r\ncls\r\n{command}\r\n"))?;
        std::process::Command::new("cmd")
            .raw_arg(format!("/c start \"Cyber CTF attack box\" cmd /c \"{}\"", bat.display()))
            .env("DOCKER_CLI_HINTS", "false")
            .spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let run = format!("clear; DOCKER_CLI_HINTS=false exec {command}");
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if std::process::Command::new(term).args(["-e", "sh", "-c", &run]).spawn().is_ok() {
                return Ok(());
            }
        }
        Err(Error::Invalid(format!("couldn't open a terminal; run this yourself: {command}")))
    }
}

#[cfg(test)]
mod tests {
    use super::{applescript_string, main_first};

    #[test]
    fn main_lab_network_comes_first() {
        let nets = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            main_first(nets(&["cyberctf-a_internal", "cyberctf-a_default", "cyberctf-a_dmz"])),
            nets(&["cyberctf-a_default", "cyberctf-a_dmz", "cyberctf-a_internal"])
        );
        assert_eq!(main_first(nets(&["cyberctf-a_lan", "cyberctf-a_dmz"])), nets(&["cyberctf-a_dmz", "cyberctf-a_lan"]));
        assert!(main_first(Vec::new()).is_empty());
    }

    #[test]
    fn applescript_escaping_keeps_shell_quoting_intact() {
        let line = r#"ssh -i '/Users/a b/key' x@h echo "hi" 'it'\''s'"#;
        assert_eq!(applescript_string(line), r#"ssh -i '/Users/a b/key' x@h echo \"hi\" 'it'\\''s'"#);
    }
}
