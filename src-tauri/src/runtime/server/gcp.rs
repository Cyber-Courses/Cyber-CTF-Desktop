//! Google Cloud: every lab of an account runs in one project, "Cyber CTF labs", created once
//! (on the account's test, or its first launch) and kept in the host profile. A project per
//! lab would use one of the billing account's few project slots each time, and Google
//! refuses past that limit ("billing quota exceeded"); one project needs a single free slot,
//! checked here with a clear message instead of a failed launch.

use tauri::AppHandle;

use super::profile::random_hex;
use super::store::{find, load, save};
use crate::error::{Error, Result};

/// The account's labs project, created when it doesn't exist yet (or was deleted).
pub async fn labs_project(app: &AppHandle, id: &str) -> Result<String> {
    let mut store = load(app)?;
    let host = find(&store, id)?;
    if let Some(p) = host.gcp_project.as_deref()
        && crate::exec::run("gcloud", &["projects", "describe", p, "--format", "value(lifecycleState)"], None).await.is_ok_and(|s| s.trim() == "ACTIVE")
    {
        return Ok(p.to_string());
    }
    let project = format!("cyberctf-labs-{}", random_hex(3));
    let mut create = vec!["projects", "create", project.as_str(), "--name", "Cyber CTF labs"];
    let org = host.node.clone().map(|o| format!("--organization={o}"));
    if let Some(o) = org.as_deref() {
        create.push(o);
    }
    crate::exec::run("gcloud", &create, None)
        .await
        .map_err(|e| Error::Invalid(format!("couldn't create the Cyber CTF labs project: {}", last_error_line(&e))))?;
    if let Err(e) = crate::exec::run("gcloud", &["billing", "projects", "link", &project, "--billing-account", &host.username], None).await {
        let _ = crate::exec::run("gcloud", &["projects", "delete", &project, "--quiet"], None).await;
        let why = last_error_line(&e);
        return Err(Error::Invalid(if why.contains("quota") || why.contains("Precondition") {
            format!(
                "No free project slot on billing account {}: Google allows only a few projects per billing account. Unlink one you don't use (gcloud billing projects unlink <project>) or request an increase at https://support.google.com/code/contact/billing_quota_increase",
                host.username
            )
        } else {
            format!("couldn't link the labs project to billing account {}: {why}", host.username)
        }));
    }
    crate::exec::run("gcloud", &["services", "enable", "compute.googleapis.com", "--project", &project], None)
        .await
        .map_err(|e| Error::Invalid(format!("couldn't enable Compute Engine on the labs project: {}", last_error_line(&e))))?;
    if let Some(h) = store.hosts.iter_mut().find(|h| h.id == id) {
        h.gcp_project = Some(project.clone());
    }
    save(app, &store)?;
    Ok(project)
}

/// The last non-blank line of a failed gcloud's stderr (its error), else the error itself.
fn last_error_line(e: &Error) -> String {
    match e {
        Error::CommandFailed { stderr, .. } => stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default().trim().to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_error_line_skips_trailing_blank_lines() {
        let e = Error::CommandFailed { command: "gcloud".into(), stderr: "WARNING: x\nERROR: quota exceeded\n\n  \n".into() };
        assert_eq!(last_error_line(&e), "ERROR: quota exceeded");
        let e = Error::CommandFailed { command: "gcloud".into(), stderr: String::new() };
        assert_eq!(last_error_line(&e), "");
        assert_eq!(last_error_line(&Error::Invalid("boom".into())), "boom");
    }
}
