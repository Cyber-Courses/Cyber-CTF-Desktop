//! Launching a lab: startLab (CyberBackend) -> download the lab at its pinned
//! commit from GitHub -> run it with CTF_API_URL / CTF_LAUNCH_TOKEN, which the
//! lab's `evidence` service exchanges for this player's evidence.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::account::api;
use crate::error::{Error, Result};
use crate::runtime::{self, Runtime, providers::Provider};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    lab_id: String,
    runtime: Runtime,
    repository: String,
    commit: String,
    env: Vec<EnvVar>,
}

#[derive(Deserialize)]
struct EnvVar {
    name: String,
    value: String,
}

/// Only CyberCTF repositories at a full commit SHA are downloaded; the API
/// enforces the same rule when labs are published.
fn validate_source(repository: &str, commit: &str) -> Result<()> {
    let repo_ok = repository.strip_prefix("CyberCTF/").is_some_and(|name| {
        !name.is_empty() && name.len() <= 100 && !name.contains("..") && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    });
    let commit_ok = commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    if repo_ok && commit_ok { Ok(()) } else { Err(Error::Invalid(format!("refusing to download {repository}@{commit}"))) }
}

/// Extracts a GitHub tarball (single top-level `<repo>-<sha>/` folder) into
/// `dest`, rejecting absolute paths, `..` and links.
fn extract(tarball: &[u8], dest: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tarball));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            continue;
        }
        let path = entry.path()?.into_owned();
        let relative: PathBuf = path.components().skip(1).collect();
        if relative.as_os_str().is_empty() {
            continue;
        }
        if relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(Error::Invalid(format!("unsafe path in lab archive: {}", path.display())));
        }
        let target = dest.join(&relative);
        if kind.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            entry.unpack(&target)?;
        }
    }
    Ok(())
}

/// Downloads the lab into `<app data>/labs/<lab id>/` unless that exact commit is
/// already installed. Extracts next to it, then swaps, so a failed download
/// never leaves a half-installed lab.
async fn install(app: &AppHandle, lab_id: &str, repository: &str, commit: &str, log: &impl Fn(String)) -> Result<PathBuf> {
    // The lab id comes from the backend and is used to build paths (join, remove_dir_all, rename).
    // Validate it like every other id so a hostile/buggy response can't escape the labs dir with
    // `..` or an absolute path. Reachable unattended through the agent, so this is the guard.
    runtime::validate_id(lab_id)?;
    validate_source(repository, commit)?;
    let labs = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("labs");
    let dir = labs.join(lab_id);
    let marker = dir.join(".cyberctf-commit");
    if std::fs::read_to_string(&marker).is_ok_and(|c| c.trim() == commit) {
        return Ok(dir);
    }

    log(format!("Downloading {repository}@{}", &commit[..12]));
    let url = format!("https://codeload.github.com/{repository}/tar.gz/{commit}");
    let res = reqwest::get(&url).await.map_err(|e| Error::Invalid(format!("download failed: {e}")))?;
    if !res.status().is_success() {
        return Err(Error::Invalid(format!("download failed: HTTP {}", res.status())));
    }
    let bytes = res.bytes().await.map_err(|e| Error::Invalid(format!("download failed: {e}")))?;

    let staging = labs.join(format!(".{lab_id}.staging"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    extract(&bytes, &staging)?;
    std::fs::write(staging.join(".cyberctf-commit"), commit)?;
    // Terraform targets fetch the lab themselves, from this repository at that commit.
    std::fs::write(staging.join(".cyberctf-repository"), repository)?;
    // Keep where the lab runs, so a lab still up on a server host or in a local VM can be
    // stopped there.
    for marker in [".cyberctf-host", runtime::LOCAL_VM_MARKER] {
        if let Ok(value) = std::fs::read(dir.join(marker)) {
            std::fs::write(staging.join(marker), value)?;
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&staging, &dir)?;
    log("Lab installed".into());
    Ok(dir)
}

/// Installs and starts a lab from a launch spec (the `startLab`/`claimLaunch` shape:
/// `{ labId, runtime, repository, commit, env }`). Shared by the manual launch command
/// and the agent's claim loop (bring your own compute).
/// VM labs run locally with `provider`, or on the server `host` when one is given.
pub(crate) async fn run(
    app: &AppHandle,
    launch_json: serde_json::Value,
    provider: Option<Provider>,
    host: Option<&str>,
    attackbox_image: Option<&str>,
    log: impl Fn(String),
) -> Result<Option<String>> {
    let launch: Launch = serde_json::from_value(launch_json).map_err(|e| Error::Invalid(format!("invalid launch spec: {e}")))?;
    let dir = install(app, &launch.lab_id, &launch.repository, &launch.commit, &log).await?;
    // Fixed names for every lab; the evidence itself is never in the environment.
    let env: Vec<(String, String)> = launch
        .env
        .into_iter()
        .filter(|v| v.name == "CTF_API_URL" || v.name == "CTF_LAUNCH_TOKEN")
        .map(|v| (v.name, v.value))
        .chain(attackbox_image.map(|i| ("CYBERCTF_ATTACKBOX_IMAGE".to_string(), i.to_string())))
        .collect();
    runtime::start(app, &dir, &launch.lab_id, launch.runtime, provider, host, &env, log).await?;
    // Where the lab's target is reachable on this machine, for the website to open.
    Ok(runtime::primary_url(&dir, &launch.lab_id, launch.runtime).await)
}

#[tauri::command]
/// `attackbox_image` starts an attack box next to the lab on a server host (where the
/// lab network isn't reachable from this machine).
pub async fn lab_launch(
    app: AppHandle,
    lab_id: String,
    provider: Option<Provider>,
    host: Option<String>,
    attackbox_image: Option<String>,
    logs: Channel<String>,
) -> Result<()> {
    if let Some(image) = &attackbox_image
        && !runtime::valid_image(image)
    {
        return Err(Error::Invalid(format!("invalid attack-box image `{image}`")));
    }
    let data =
        api::graphql("mutation ($id: ID!) { startLab(labId: $id) { labId runtime repository commit env { name value } } }", json!({ "id": lab_id }), true)
            .await?;
    let startlab = data["startLab"].clone();
    // The deploy runs in a detached worker process, so quitting (or crashing) this app never
    // cuts a vagrant/docker/terraform run short; this command only follows the worker's log.
    let job = crate::deploy_worker::Job {
        lab_id: lab_id.clone(),
        launch: startlab.clone(),
        provider,
        host: host.clone(),
        attackbox_image: attackbox_image.clone(),
    };
    match crate::deploy_worker::spawn(&app, &job) {
        Ok(spawned) => {
            let follow = logs.clone();
            crate::deploy_worker::tail(&spawned, move |line| {
                let _ = follow.send(line);
            })
            .await
        }
        // Fallback: deploy in this process, on a detached task (a webview reload aborts this
        // command future and the child is kill_on_drop, so inline would be cut short). The app
        // then has to stay open until it finishes; the quit guard keeps it alive.
        Err(e) => {
            let _ = logs.send(format!("Deploying inside the app (a background worker couldn't be started: {e}). Keep the app open until it finishes."));
            let handle = tauri::async_runtime::spawn(async move {
                let log = move |line: String| {
                    let _ = logs.send(line);
                };
                run(&app, startlab, provider, host.as_deref(), attackbox_image.as_deref(), log).await
            });
            handle.await.map_err(|e| Error::Invalid(format!("the deploy task did not finish: {e}")))??;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cyberctf_repos_at_full_shas() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert!(validate_source("CyberCTF/invoice-portal-sqli", sha).is_ok());
        for (repo, commit) in [
            ("someone/lab", sha),
            ("CyberCTF/", sha),
            ("CyberCTF/../x", sha),
            ("CyberCTF/a/b", sha),
            ("CyberCTF/lab", "main"),
            ("CyberCTF/lab", &sha.to_uppercase()),
        ] {
            assert!(validate_source(repo, commit).is_err(), "{repo}@{commit}");
        }
    }

    fn tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            // Write the raw name so tests can include `..` (append_data refuses it).
            let name = header.as_old_mut().name.as_mut();
            name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn extracts_without_the_top_level_folder() {
        let dir = std::env::temp_dir().join(format!("cyberctf-extract-{}", rand::random::<u32>()));
        extract(&tarball(&[("lab-abc/docker-compose.yml", b"services: {}"), ("lab-abc/evidence/claim.sh", b"#!/bin/sh")]), &dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("docker-compose.yml")).unwrap(), "services: {}");
        assert!(dir.join("evidence/claim.sh").is_file());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_path_traversal_in_archives() {
        let dir = std::env::temp_dir().join(format!("cyberctf-extract-{}", rand::random::<u32>()));
        let err = extract(&tarball(&[("lab-abc/../../evil", b"x")]), &dir);
        assert!(err.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
