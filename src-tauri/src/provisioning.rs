//! The Docker images provisioning uses, so the UI can show them as present / pullable. Ansible
//! runs in a container; Terraform runs from a local binary (a dependency install instead).

use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::exec::{run, stream, valid_image};
use crate::platform::steps::channel_log;

// Ansible is kept as a container image (it runs poorly natively on Windows); Terraform,
// by contrast, is offered as a local install (simpler state), so it isn't listed here.
// TODO: confirm the Ansible runner image with the provisioning design (placeholder).
const ANSIBLE_IMAGE: &str = "willhallonline/ansible:latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageReq {
    pub name: String,
    pub image: String,
    pub present: bool,
}

/// The provisioning images and whether each is pulled locally.
#[tauri::command]
pub async fn provisioning_images() -> Vec<ImageReq> {
    let mut out = Vec::new();
    for (name, image) in [("Ansible", ANSIBLE_IMAGE)] {
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
    stream("docker", &["pull", &image], None, &[], channel_log(logs)).await
}
