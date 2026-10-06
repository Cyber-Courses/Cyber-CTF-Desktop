//! Isoloom's registry of running environments (`~/.isoloom/status.yml`): the launcher records
//! what it starts and forgets what it stops, so `isoloom status`, `connect` and `exec` see
//! launcher-run labs too. Best effort: a registry that can't be written never fails a launch.

use std::path::{Path, PathBuf};

use isoloom_core::{Spec, Target, registry};

fn key(dir: &Path) -> PathBuf {
    dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
}

/// Records the lab as running on `target` (and, for the clouds, in which one).
pub fn record(dir: &Path, spec: &Spec, target: Target, cloud: Option<&str>) {
    let entry = registry::Entry { name: spec.name.clone(), dir: key(dir), target, instance: None, cloud: cloud.map(str::to_string), started: registry::now() };
    let _ = registry::load().and_then(|mut reg| {
        reg.upsert(entry);
        registry::save(&reg)
    });
}

/// Forgets every entry of the lab (whatever target it ran on).
pub fn forget(dir: &Path) {
    let dir = key(dir);
    let _ = registry::load().and_then(|mut reg| {
        reg.environments.retain(|e| e.dir != dir);
        registry::save(&reg)
    });
}
