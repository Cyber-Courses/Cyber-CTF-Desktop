//! The Docker images provisioning uses (Terraform to create, Ansible to configure), so
//! the UI can show them as present / pullable. Both run in containers, no host binaries.

use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::exec::{run, stream};

// Keep in sync with runtime::terraform::IMAGE.
const TERRAFORM_IMAGE: &str = "hashicorp/terraform:1.16.5";
// TODO: confirm the Ansible runner image with the provisioning design (placeholder).
const ANSIBLE_IMAGE: &str = "willhallonline/ansible:latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageReq {
    pub name: String,
    pub image: String,
    pub present: bool,
}

fn valid_image(image: &str) -> bool {
    !image.is_empty()
        && image.len() <= 200
        && !image.starts_with('-')
        && image.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '@'))
}

/// The provisioning images and whether each is pulled locally.
#[tauri::command]
pub async fn provisioning_images() -> Vec<ImageReq> {
    let mut out = Vec::new();
    for (name, image) in [("Terraform", TERRAFORM_IMAGE), ("Ansible", ANSIBLE_IMAGE)] {
        let present = run("docker", &["image", "inspect", image], None).await.is_ok();
        out.push(ImageReq { name: name.to_string(), image: image.to_string(), present });
    }
    out
}

/// Pulls a provisioning image, streaming docker's output.
#[tauri::command]
pub async fn provisioning_pull(image: String, logs: Channel<String>) -> Result<()> {
    if !valid_image(&image) {
        return Err(Error::Invalid(format!("invalid image `{image}`")));
    }
    let on_line = move |line: String| {
        let _ = logs.send(line);
    };
    stream("docker", &["pull", &image], None, &[], on_line).await
}
