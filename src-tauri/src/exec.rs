use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{Error, Result};

/// Tools that ship as a `.cmd`/`.bat` wrapper on Windows (not a real `.exe`). `CreateProcessW`
/// only appends `.exe` and does not consult `PATHEXT`, so `Command::new("az")` can't find
/// `az.cmd`; these must be launched through `cmd.exe`. `aws`/`terraform`/`docker`/`vagrant`
/// are real `.exe` and resolve directly.
#[cfg(windows)]
const WINDOWS_CMD_SHIM: &[&str] = &["az", "gcloud"];

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

/// `run` with extra environment variables.
pub async fn run_env(program: &'static str, args: &[&str], cwd: Option<&Path>, env: &[(String, String)]) -> Result<String> {
    let mut cmd = build(program, args);
    cmd.stdin(Stdio::null());
    cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let output = cmd.output().await.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::ToolMissing { tool: program },
        _ => Error::Io(e),
    })?;
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
    while !(out_done && err_done) {
        tokio::select! {
            line = stdout.next_line(), if !out_done => match line? { Some(l) => on_line(l), None => out_done = true },
            line = stderr.next_line(), if !err_done => match line? { Some(l) => on_line(l), None => err_done = true },
        }
    }

    let status = child.wait().await?;
    if !status.success() {
        return Err(Error::CommandFailed { command: format!("{program} {}", args.join(" ")), stderr: format!("exited with {status}") });
    }
    Ok(())
}
