//! How big an attack-box image is to download, as Docker Hub reports it for this machine's
//! architecture. Facts only: an image Docker Hub doesn't describe (another registry, a
//! private or unpublished tag) has no size, rather than a guessed one.

use std::time::Duration;

/// Docker Hub's `namespace/repo` and tag for an image reference, or None when the image
/// lives on another registry. `kali` -> `library/kali`, no tag -> `latest`.
fn hub_ref(image: &str) -> Option<(String, String)> {
    let image = image.split('@').next()?;
    let (path, tag) = match image.rsplit_once(':') {
        Some((p, t)) if !t.contains('/') => (p, t),
        _ => (image, "latest"),
    };
    let mut parts: Vec<&str> = path.split('/').collect();
    if parts.len() > 1 && (parts[0].contains('.') || parts[0].contains(':') || parts[0] == "localhost") {
        if parts[0] != "docker.io" {
            return None;
        }
        parts.remove(0);
    }
    let repo = if parts.len() == 1 { format!("library/{}", parts[0]) } else { parts.join("/") };
    Some((repo, tag.to_string()))
}

/// Same guard as the attack box: a normal `registry/name:tag@digest`, nothing that reads as a flag.
fn valid(image: &str) -> bool {
    !image.is_empty()
        && image.len() <= 200
        && !image.starts_with('-')
        && image.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '@'))
}

/// Docker Hub's name for this machine's CPU architecture.
fn hub_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    }
}

/// Compressed download size in bytes of `image` for this machine, from Docker Hub.
#[tauri::command]
pub async fn image_download_size(image: String) -> Option<u64> {
    if !valid(&image) {
        return None;
    }
    let (repo, tag) = hub_ref(&image)?;
    let url = format!("https://hub.docker.com/v2/repositories/{repo}/tags/{tag}");
    let res = reqwest::Client::new().get(url).timeout(Duration::from_secs(8)).send().await.ok()?;
    let v: serde_json::Value = res.error_for_status().ok()?.json().await.ok()?;
    v.get("images")?
        .as_array()?
        .iter()
        .find(|i| i.get("architecture").and_then(|a| a.as_str()) == Some(hub_arch()))
        .and_then(|i| i.get("size")?.as_u64())
        .filter(|s| *s > 0)
}

#[cfg(test)]
mod tests {
    use super::hub_ref;

    #[test]
    fn maps_image_references_to_docker_hub() {
        let r = |s: &str| hub_ref(s).map(|(a, b)| format!("{a}:{b}"));
        assert_eq!(r("cyberctf/attack-box").as_deref(), Some("cyberctf/attack-box:latest"));
        assert_eq!(r("nwodtuhs/exegol:free").as_deref(), Some("nwodtuhs/exegol:free"));
        assert_eq!(r("kali").as_deref(), Some("library/kali:latest"));
        assert_eq!(r("docker.io/kalilinux/kali-rolling:2026.3").as_deref(), Some("kalilinux/kali-rolling:2026.3"));
        assert_eq!(r("ghcr.io/org/image:1"), None);
        assert_eq!(r("localhost:5000/x"), None);
    }
}
