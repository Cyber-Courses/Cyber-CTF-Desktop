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

/// The identity the host AWS CLI resolves from its default credential chain (from
/// `aws configure`), if any, so the cloud setup can offer "use the CLI's credentials"
/// instead of pasting keys. None when the CLI is missing or has no configured credentials.
#[tauri::command]
pub async fn aws_cli_identity() -> Option<String> {
    run("aws", &["sts", "get-caller-identity", "--query", "Arn", "--output", "text"], None)
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
