use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{Error, Result};

/// Tools that may ship as a `.cmd`/`.bat` wrapper on Windows (not a real `.exe`). `CreateProcessW`
/// only appends `.exe` and does not consult `PATHEXT`, so `Command::new("az")` can't find
/// `az.cmd`; these go through `cmd.exe` (which also resolves a plain `.exe`, so it's safe for a
/// tool whose Windows form varies, like `oci`). `aws`/`terraform`/`docker`/`vagrant` are real
/// `.exe` and resolve directly.
#[cfg(windows)]
const WINDOWS_CMD_SHIM: &[&str] = &["az", "gcloud", "oci"];

/// Builds the Command, routing Windows batch-wrapper tools through `cmd /C` so they resolve.
/// Environment variables that would redirect the Docker CLI to a different engine than the one
/// the user configured as current (`docker context use`, which Docker Desktop's UI reflects).
/// A process that launches the app (an IDE, a terminal integration, another tool) can carry a
/// stale `DOCKER_HOST` or `DOCKER_CONTEXT` — e.g. pointing at OrbStack's `/var/run/docker.sock`
/// while the user works in Docker Desktop. Every lab would then deploy to, and be looked for in,
/// an engine the user never sees: status reads "not running" and a launch looks like it reset.
/// Stripping these makes the launcher follow the configured current context, so it always agrees
/// with `docker context show` and the Desktop UI.
const DOCKER_ENGINE_OVERRIDES: [&str; 2] = ["DOCKER_HOST", "DOCKER_CONTEXT"];

/// Whether `program` talks to the Docker engine (`docker`, including `docker compose`, a CLI
/// plugin of the same binary), and so must not inherit an engine override.
fn uses_docker_engine(program: &str) -> bool {
    program == "docker"
}

/// On Windows, every child of a windowed app gets a console window of its own unless told not
/// to: the status polls (docker, vagrant, VBoxManage) would flash one on screen every few
/// seconds. `CREATE_NO_WINDOW` keeps them headless; their output is piped anyway.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keeps a child process off the screen on Windows (no-op elsewhere).
pub fn headless(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `headless` for a blocking `std::process::Command` (only Windows code calls it).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn headless_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn build(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    if WINDOWS_CMD_SHIM.contains(&program) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program).args(args);
        headless(&mut cmd);
        return cmd;
    }
    let mut cmd = Command::new(program);
    cmd.args(args);
    headless(&mut cmd);
    if uses_docker_engine(program) {
        for var in DOCKER_ENGINE_OVERRIDES {
            cmd.env_remove(var);
        }
    }
    cmd
}

/// Runs a program without a shell (arguments are never interpolated) and returns stdout.
pub async fn run(program: &'static str, args: &[&str], cwd: Option<&Path>) -> Result<String> {
    run_env(program, args, cwd, &[]).await
}

/// How long a read-only status probe (docker/vagrant inspect, ps, network ls) may take before
/// it's treated as a stuck tool. Polled paths use this so a wedged daemon can't hang the UI.
pub const STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// `run` with the shared status timeout, for polled read-only probes.
pub async fn run_read(program: &'static str, args: &[&str], cwd: Option<&Path>) -> Result<String> {
    run_inner(program, args, cwd, &[], Some(STATUS_TIMEOUT)).await
}

/// `run` with extra environment variables.
pub async fn run_env(program: &'static str, args: &[&str], cwd: Option<&Path>, env: &[(String, String)]) -> Result<String> {
    run_inner(program, args, cwd, env, None).await
}

/// `run_env` that gives up after `timeout`, killing the process, instead of waiting forever.
/// For read-only probes (status, inspect) where a wedged tool must not hang the caller: a
/// stuck VirtualBox or Docker daemon then surfaces as an error rather than piling up.
pub async fn run_env_timed(program: &'static str, args: &[&str], cwd: Option<&Path>, env: &[(String, String)], timeout: std::time::Duration) -> Result<String> {
    run_inner(program, args, cwd, env, Some(timeout)).await
}

/// Kills a spawned tool's whole process group when dropped, unless disarmed after it exited.
struct GroupGuard(Option<u32>);

impl GroupGuard {
    fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // SAFETY: plain syscall; the group was created by `process_group(0)` at spawn.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

async fn run_inner(program: &'static str, args: &[&str], cwd: Option<&Path>, env: &[(String, String)], timeout: Option<std::time::Duration>) -> Result<String> {
    let mut cmd = build(program, args);
    cmd.stdin(Stdio::null());
    cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let to_err = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => Error::ToolMissing { tool: program },
        _ => Error::Io(e),
    };
    // Kill the child if this future is dropped (cancellation), so a long tool (vagrant/docker/
    // cloud CLI) isn't left orphaned.
    cmd.kill_on_drop(true);
    let output = match timeout {
        None => cmd.output().await.map_err(to_err)?,
        Some(dur) => {
            // `spawn` (unlike `output`) inherits the parent's stdio by default, so without
            // explicit pipes `wait_with_output` returns an empty stdout even though the tool
            // printed plenty: every timed status probe then read as "nothing running".
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            // Its own process group, so a timeout or cancellation kills the whole tree: `vagrant`
            // is a wrapper that starts `ruby` as a child, and killing only the wrapper orphaned
            // one ruby per timed-out poll until they all deadlocked on Vagrant's lock.
            #[cfg(unix)]
            cmd.process_group(0);
            let child = cmd.spawn().map_err(to_err)?;
            let group = GroupGuard(child.id());
            let waited = tokio::time::timeout(dur, child.wait_with_output()).await;
            if waited.is_ok() {
                group.disarm();
            }
            match waited {
                Ok(out) => out.map_err(to_err)?,
                Err(_) => {
                    return Err(Error::CommandFailed {
                        command: format!("{program} {}", args.join(" ")),
                        stderr: format!("timed out after {}s (the tool or its backend may be stuck)", dur.as_secs()),
                    });
                }
            }
        }
    };
    if !output.status.success() {
        return Err(Error::CommandFailed {
            command: format!("{program} {}", args.join(" ")),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Like `run`, but adds `env` to the process environment and forwards every
/// stdout/stderr line to `on_line` as it arrives.
pub async fn stream(program: &'static str, args: &[&str], cwd: Option<&Path>, env: &[(String, String)], mut on_line: impl FnMut(String)) -> Result<()> {
    let mut cmd = build(program, args);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    // Kill the child (and, with it, the long-lived process we stream) if this future is dropped,
    // rather than orphaning a vagrant/docker/terraform run.
    cmd.kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::ToolMissing { tool: program },
        _ => Error::Io(e),
    })?;

    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut stderr = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
    let (mut out_done, mut err_done) = (false, false);
    // Keep the last few stderr lines so a failure's error carries the actual cause, not just the
    // exit status (callers that surface the returned error, not the log channel, rely on this).
    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    while !(out_done && err_done) {
        tokio::select! {
            line = stdout.next_line(), if !out_done => match line? { Some(l) => on_line(l), None => out_done = true },
            line = stderr.next_line(), if !err_done => match line? {
                Some(l) => {
                    if tail.len() == 10 { tail.pop_front(); }
                    tail.push_back(l.clone());
                    on_line(l);
                }
                None => err_done = true,
            },
        }
    }

    let status = child.wait().await?;
    if !status.success() {
        let cause = tail.iter().cloned().collect::<Vec<_>>().join("\n");
        let stderr = if cause.trim().is_empty() { format!("exited with {status}") } else { format!("{} (exited with {status})", cause.trim()) };
        return Err(Error::CommandFailed { command: format!("{program} {}", args.join(" ")), stderr });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{DOCKER_ENGINE_OVERRIDES, uses_docker_engine};

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_reads_capture_the_tools_output() {
        // Regression: the timed path spawned without piping stdout, so `wait_with_output`
        // returned "" for every status probe (docker ps, compose ps, vagrant status). Labs read
        // as not running and a successful launch looked like it reset. A timed read must return
        // what the tool printed, exactly like the untimed one.
        let timed = super::run_read("sh", &["-c", "printf hi"], None).await.unwrap();
        assert_eq!(timed, "hi");
        let untimed = super::run("sh", &["-c", "printf hi"], None).await.unwrap();
        assert_eq!(timed, untimed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_reads_surface_stderr_on_failure() {
        // A failing tool's message is piped too, so it reaches the error instead of vanishing.
        let err = super::run_read("sh", &["-c", "echo boom >&2; exit 3"], None).await.unwrap_err();
        assert!(matches!(err, super::Error::CommandFailed { ref stderr, .. } if stderr.contains("boom")), "{err:?}");
    }

    #[test]
    fn only_docker_drops_inherited_engine_overrides() {
        // Regression: an inherited DOCKER_HOST pointed the app at OrbStack while the user worked
        // in Docker Desktop, so labs were deployed to and looked for in the wrong engine.
        assert!(uses_docker_engine("docker"));
        assert!(!uses_docker_engine("vagrant"));
        assert!(!uses_docker_engine("terraform"));
        assert_eq!(DOCKER_ENGINE_OVERRIDES, ["DOCKER_HOST", "DOCKER_CONTEXT"]);
    }
}
