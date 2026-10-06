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
fn build(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    if WINDOWS_CMD_SHIM.contains(&program) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program).args(args);
        return cmd;
    }
    let mut cmd = Command::new(program);
    cmd.args(args);
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
            let child = cmd.spawn().map_err(to_err)?;
            match tokio::time::timeout(dur, child.wait_with_output()).await {
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
