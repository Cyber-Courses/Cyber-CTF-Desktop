//! The attack box shell inside the app: a pseudo-terminal running the same command line the
//! system terminal would (`docker exec -it …`, `ssh -t …`, `vagrant ssh`), streamed to an
//! xterm.js view. No Terminal.app window with a title we can't control, and no macOS
//! Automation prompt for driving Terminal.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::AppHandle;
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::runtime::{Runtime, ShellKind, shell_command_for};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// The window showing it: closing that window ends it (the page's own cleanup never runs
    /// when its webview is destroyed).
    window: String,
}

/// Kills a session's shell and reaps it, off the calling thread (sync commands run on the main
/// thread): a killed child that is never waited on stays a zombie while the app runs.
fn end(mut sess: Session) {
    let _ = sess.child.kill();
    std::thread::spawn(move || {
        let _ = sess.child.wait();
    });
}

static SESSIONS: Mutex<Option<HashMap<u32, Session>>> = Mutex::new(None);
static NEXT_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

fn with_sessions<T>(f: impl FnOnce(&mut HashMap<u32, Session>) -> T) -> T {
    let mut guard = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TermEvent {
    /// Output, as text (split multi-byte characters are held back until complete).
    Data { data: String },
    /// The shell ended.
    Exit { code: Option<u32> },
}

/// Splits `buf` into the text that is complete and the bytes of a character cut off at its end.
fn take_text(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_string();
            buf.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            // An incomplete character at the end: keep it for the next read.
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&buf[..valid]).into_owned();
            buf.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            out
        }
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// Starts the shell for a lab in a pseudo-terminal; output goes to `events`. Returns the session.
#[tauri::command]
pub async fn terminal_open(
    window: tauri::WebviewWindow,
    id: String,
    kind: ShellKind,
    runtime: Runtime,
    cols: u16,
    rows: u16,
    events: Channel<TermEvent>,
) -> Result<u32> {
    use tauri::Manager;
    let line = shell_command_for(window.app_handle(), &id, kind, runtime).await?;
    let pair = native_pty_system().openpty(pty_size(cols, rows)).map_err(|e| Error::Invalid(format!("couldn't open a terminal: {e}")))?;
    #[cfg(unix)]
    let mut cmd = {
        let mut c = CommandBuilder::new("sh");
        c.args(["-c", &format!("exec {line}")]);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = CommandBuilder::new("cmd");
        c.args(["/c", &line.replace('\'', "\"")]);
        c
    };
    cmd.env("TERM", "xterm-256color");
    // Docker's "What's next" ad on exit.
    cmd.env("DOCKER_CLI_HINTS", "false");
    let child = pair.slave.spawn_command(cmd).map_err(|e| Error::Invalid(format!("couldn't start the shell: {e}")))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| Error::Invalid(e.to_string()))?;
    let writer = pair.master.take_writer().map_err(|e| Error::Invalid(e.to_string()))?;
    let session = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let window = window.label().to_string();
    with_sessions(|s| s.insert(session, Session { writer, master: pair.master, child, window }));

    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&chunk[..n]);
                    let data = take_text(&mut pending);
                    if !data.is_empty() && events.send(TermEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
        let code = with_sessions(|s| s.remove(&session)).and_then(|mut sess| sess.child.wait().ok()).map(|st| st.exit_code());
        let _ = events.send(TermEvent::Exit { code });
    });
    Ok(session)
}

/// Sends keystrokes (or pasted text) to the shell.
#[tauri::command]
pub fn terminal_write(session: u32, data: String) -> Result<()> {
    with_sessions(|s| match s.get_mut(&session) {
        Some(sess) => sess.writer.write_all(data.as_bytes()).and_then(|_| sess.writer.flush()).map_err(Error::Io),
        None => Err(Error::Invalid("the shell has ended".into())),
    })
}

/// Follows the view's size, so full-screen tools (vim, less, htop) lay out right.
#[tauri::command]
pub fn terminal_resize(session: u32, cols: u16, rows: u16) -> Result<()> {
    with_sessions(|s| match s.get(&session) {
        Some(sess) => sess.master.resize(pty_size(cols, rows)).map_err(|e| Error::Invalid(e.to_string())),
        None => Ok(()),
    })
}

/// Ends the shell (the view was closed).
#[tauri::command]
pub fn terminal_close(session: u32) -> Result<()> {
    if let Some(sess) = with_sessions(|s| s.remove(&session)) {
        end(sess);
    }
    Ok(())
}

/// Ends the shells a window was showing, when it is closed.
fn close_window(label: &str) {
    let ids: Vec<u32> = with_sessions(|s| s.iter().filter(|(_, v)| v.window == label).map(|(k, _)| *k).collect());
    for id in ids {
        if let Some(sess) = with_sessions(|s| s.remove(&id)) {
            end(sess);
        }
    }
}

/// Ends every shell, when the app exits.
pub fn close_all() {
    let all: Vec<Session> = with_sessions(|s| s.drain().map(|(_, v)| v).collect());
    for mut sess in all {
        let _ = sess.child.kill();
    }
}

/// Opens (or focuses) a lab's shell window.
#[tauri::command]
pub fn terminal_window(app: AppHandle, id: String, kind: ShellKind, runtime: Runtime, title: String) -> Result<()> {
    use tauri::Manager;
    crate::runtime::validate_id(&id)?;
    let k = match kind {
        ShellKind::Lab => "lab",
        ShellKind::AttackVm => "attackVm",
    };
    let label = format!("shell-{k}-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let rt = match runtime {
        Runtime::Docker => "DOCKER",
        Runtime::Vm => "VM",
    };
    let path = format!("shell?id={id}&kind={k}&runtime={rt}");
    let title: String = title.chars().filter(|c| !c.is_control()).take(80).collect();
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(path.into()))
        .title(format!("{title} · attack box"))
        .inner_size(900.0, 560.0)
        .min_inner_size(480.0, 280.0)
        .resizable(true);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    let window = builder.build().map_err(|e| Error::Invalid(format!("could not open the shell window: {e}")))?;
    window.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            close_window(&label);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_characters_wait_for_their_last_byte() {
        let euro = "€".as_bytes(); // 3 bytes
        let mut buf = vec![b'a', euro[0], euro[1]];
        assert_eq!(take_text(&mut buf), "a");
        assert_eq!(buf, vec![euro[0], euro[1]]);
        buf.push(euro[2]);
        assert_eq!(take_text(&mut buf), "€");
        assert!(buf.is_empty());
        let mut bad = vec![b'x', 0xff, b'y'];
        assert_eq!(take_text(&mut bad), "x\u{fffd}y");
    }

    #[cfg(unix)]
    #[test]
    fn a_pty_runs_a_command_and_reports_its_exit() {
        let pair = native_pty_system().openpty(pty_size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "printf 'hi\\n'; exit 3"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = Vec::new();
        let mut chunk = [0u8; 256];
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&chunk[..n]);
            if out.windows(2).any(|w| w == b"hi") {
                break;
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("hi"));
        assert_eq!(child.wait().unwrap().exit_code(), 3);
    }
}
