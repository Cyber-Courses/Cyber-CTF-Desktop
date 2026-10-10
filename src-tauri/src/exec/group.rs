//! Process groups of timed tools, so a timeout, a cancellation or the app's exit kills the whole
//! tree a tool started, not just the tool.

use std::sync::Mutex;

/// Process groups of timed tools still running, so they can be ended when the app exits: an
/// exit doesn't drop their guards, and a leftover `vagrant status` keeps the machine's lock
/// (every later status of that lab then fails as "locked").
static LIVE_GROUPS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Kills a spawned tool's whole process group when dropped, unless disarmed after it exited.
pub(super) struct GroupGuard(Option<u32>);

impl GroupGuard {
    pub(super) fn new(pid: Option<u32>) -> Self {
        if let (Some(p), Ok(mut live)) = (pid, LIVE_GROUPS.lock()) {
            live.push(p);
        }
        GroupGuard(pid)
    }

    pub(super) fn disarm(mut self) {
        forget(self.0.take());
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            kill(pid);
            forget(Some(pid));
        }
    }
}

fn forget(pid: Option<u32>) {
    if let (Some(p), Ok(mut live)) = (pid, LIVE_GROUPS.lock()) {
        live.retain(|g| *g != p);
    }
}

fn kill(pid: u32) {
    #[cfg(unix)]
    // SAFETY: plain syscall; the group was created by `process_group(0)` at spawn.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Ends every timed tool this process started that is still running. For the app's exit; the
/// deploy worker is its own process, so a deploy in progress is not affected.
pub fn kill_live_tools() {
    let groups = LIVE_GROUPS.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
    for pid in groups {
        kill(pid);
    }
}
