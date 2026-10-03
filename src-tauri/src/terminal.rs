//! Embedded interactive shells into the attack box. We run `docker exec -it <exegol>
//! zsh` under a PTY and bridge it to an xterm.js terminal in the webview: bytes out
//! stream over a Channel (base64), keystrokes come back through `exegol_shell_write`.
//! One shell per lab, keyed by lab id.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{Error, Result};

struct Shell {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Shells(Mutex<HashMap<String, Shell>>);

fn pty_err(e: impl std::fmt::Display) -> Error {
    Error::Invalid(e.to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn container(id: &str) -> String {
    format!("cyberctf-{id}-exegol")
}

/// Opens a shell into the lab's attack box, streaming its output to `output` as
/// base64 chunks. Replaces any existing shell for the same lab.
#[tauri::command]
pub fn exegol_shell_open(id: String, cols: u16, rows: u16, output: Channel<String>, shells: State<Shells>) -> Result<()> {
    if !valid_id(&id) {
        return Err(Error::Invalid(format!("invalid lab id `{id}`")));
    }
    // Drop any previous shell for this lab first.
    if let Some(mut old) = shells.0.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }

    let system = portable_pty::native_pty_system();
    let pair = system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(pty_err)?;

    let mut cmd = CommandBuilder::new("docker");
    // Prefer zsh (Exegol), fall back to bash (Kali/Parrot) or sh, so any attack image works.
    cmd.args(["exec", "-it", &container(&id), "sh", "-c", "exec $(command -v zsh || command -v bash || command -v sh)"]);
    let child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
    let writer = pair.master.take_writer().map_err(pty_err)?;

    // Pump the PTY output to the webview until it closes.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if output.send(chunk).is_err() {
                        break;
                    }
                }
            }
        }
    });

    shells.0.lock().unwrap().insert(id, Shell { writer, master: pair.master, child });
    Ok(())
}

/// Sends keystrokes (raw UTF-8) to the shell.
#[tauri::command]
pub fn exegol_shell_write(id: String, data: String, shells: State<Shells>) -> Result<()> {
    let mut map = shells.0.lock().unwrap();
    if let Some(shell) = map.get_mut(&id) {
        shell.writer.write_all(data.as_bytes()).map_err(Error::Io)?;
        shell.writer.flush().map_err(Error::Io)?;
    }
    Ok(())
}

/// Resizes the PTY when the terminal element resizes.
#[tauri::command]
pub fn exegol_shell_resize(id: String, cols: u16, rows: u16, shells: State<Shells>) -> Result<()> {
    let map = shells.0.lock().unwrap();
    if let Some(shell) = map.get(&id) {
        shell
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(pty_err)?;
    }
    Ok(())
}

/// Closes the shell and kills the `docker exec` process.
#[tauri::command]
pub fn exegol_shell_close(id: String, shells: State<Shells>) -> Result<()> {
    if let Some(mut shell) = shells.0.lock().unwrap().remove(&id) {
        let _ = shell.child.kill();
    }
    Ok(())
}
