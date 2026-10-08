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
    upsert(dir, spec, target, cloud, None);
}

/// Records a lab running on local Docker, with the Compose project it runs as (the launcher's
/// own name, not the file's), so Isoloom's `status`, `connect` and `exec` find it.
pub fn record_docker(dir: &Path, spec: &Spec, project: String) {
    upsert(dir, spec, Target::Docker, None, Some(project));
}

fn upsert(dir: &Path, spec: &Spec, target: Target, cloud: Option<&str>, project: Option<String>) {
    let entry = registry::Entry {
        name: spec.name.clone(),
        dir: key(dir),
        target,
        instance: super::lab::instance(dir),
        cloud: cloud.map(str::to_string),
        project,
        started: registry::now(),
    };
    let _ = registry::update(|reg| reg.upsert(entry));
}

/// Forgets every entry of the lab (whatever target it ran on).
pub fn forget(dir: &Path) {
    let dir = key(dir);
    let _ = registry::update(|reg| reg.environments.retain(|e| e.dir != dir));
}
