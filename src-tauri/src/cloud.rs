//! Cloud account connection via each provider's own CLI auth (browser flow), so we don't
//! store long-lived cloud secrets. Terraform then uses the CLI's credential chain.

use serde::Deserialize;
use tauri::ipc::Channel;

use crate::error::Result;
use crate::exec::{run, stream};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cloud {
    Aws,
    Azure,
    Gcp,
}

/// Signs in to a cloud provider using its CLI. AWS uses SSO (needs a configured SSO
/// profile); Azure and GCP open the browser. Streams the CLI output to the UI.
#[tauri::command]
pub async fn cloud_login(provider: Cloud, logs: Channel<String>) -> Result<()> {
    let on_line = move |line: String| {
        let _ = logs.send(line);
    };
    let (program, args): (&'static str, &[&str]) = match provider {
        Cloud::Aws => ("aws", &["sso", "login"]),
        Cloud::Azure => ("az", &["login"]),
        Cloud::Gcp => ("gcloud", &["auth", "application-default", "login"]),
    };
    on_line(format!("$ {program} {}", args.join(" ")));
    stream(program, args, None, &[], on_line).await
}

/// The identity the host AWS CLI resolves (for the given profile, or the default chain),
/// if any, so the cloud setup can show "signed in as …" and offer using the CLI instead of
/// pasting keys. None when the CLI is missing or that profile has no usable credentials.
#[tauri::command]
pub async fn aws_cli_identity(profile: Option<String>) -> Option<String> {
    let mut args = vec!["sts", "get-caller-identity", "--query", "Arn", "--output", "text"];
    if let Some(p) = profile.as_deref() {
        args.push("--profile");
        args.push(p);
    }
    run("aws", &args, None).await.ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The AWS CLI profiles configured on this machine (`aws configure list-profiles`), so the
/// user can pick one when they have several. Empty when the CLI is missing or has none.
#[tauri::command]
pub async fn aws_profiles() -> Vec<String> {
    run("aws", &["configure", "list-profiles"], None)
        .await
        .ok()
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// Signs in to AWS IAM Identity Center (SSO) in the browser, for a profile that uses it.
/// Streams the CLI output. Requires the profile to be SSO-configured (`aws configure sso`).
#[tauri::command]
pub async fn aws_sso_login(profile: Option<String>, logs: Channel<String>) -> Result<()> {
    let on_line = move |line: String| {
        let _ = logs.send(line);
    };
    let mut args = vec!["sso", "login"];
    if let Some(p) = profile.as_deref() {
        args.push("--profile");
        args.push(p);
    }
    on_line(format!("$ aws {}", args.join(" ")));
    stream("aws", &args, None, &[], on_line).await
}
