//! The container self-test: a throwaway two-container lab.

use std::path::Path;
use std::time::Duration;

use super::Reporter;
use super::downloads::ensure_image;
use crate::error::{Error, Result};
use crate::exec::run;

const PROJECT: &str = "cyberctf-selftest";
pub(crate) const IMAGE: &str = "busybox:1.36";
/// What the test web server serves, so a reply is known to come from it.
const MARKER: &str = "cyberctf-selftest-ok";
/// Tries (500 ms apart) for the lab's web server to answer: httpd needs a moment.
const ANSWER_TRIES: u32 = 10;
const RETRY: Duration = Duration::from_millis(500);

fn compose_file() -> String {
    format!(
        r#"services:
  web:
    image: {IMAGE}
    command: ["sh", "-c", "mkdir -p /www && echo {MARKER} > /www/index.html && httpd -f -p 80 -h /www"]
    ports: ["127.0.0.1::80"]
  probe:
    image: {IMAGE}
    command: ["sleep", "300"]
"#
    )
}

async fn compose(dir: &Path, rest: &[&str]) -> Result<String> {
    let mut args = vec!["compose", "-p", PROJECT, "-f", "docker-compose.yml"];
    args.extend_from_slice(rest);
    run("docker", &args, Some(dir)).await
}

pub(super) async fn run_test(dir: &Path, r: &Reporter) -> Result<()> {
    std::fs::write(dir.join("docker-compose.yml"), compose_file())?;
    let res = steps(dir, r).await;
    // Always tear the test lab down, even after a failed step.
    let down = compose(dir, &["down", "-v", "--remove-orphans", "-t", "0"]).await;
    r.cleanup("Clean up", &res, down, None);
    res
}

async fn steps(dir: &Path, r: &Reporter) -> Result<()> {
    r.step("engine", "Container engine answers", async {
        let v = crate::exec::run_read("docker", &["info", "--format", "{{.ServerVersion}}"], None).await?;
        Ok(((), Some(format!("Docker {}", v.trim()))))
    })
    .await?;

    r.step("pull", "Download a test image", async {
        let had = ensure_image().await?;
        Ok(((), Some(if had { format!("{IMAGE} (ready)") } else { IMAGE.to_string() })))
    })
    .await?;

    r.step("start", "Start a two-container test lab", async {
        compose(dir, &["up", "-d", "--quiet-pull"]).await?;
        Ok(((), None))
    })
    .await?;

    r.step("network", "Containers reach each other", async {
        let mut last = String::new();
        for _ in 0..ANSWER_TRIES {
            match compose(dir, &["exec", "-T", "probe", "wget", "-qO-", "-T", "2", "http://web"]).await {
                Ok(out) if out.contains(MARKER) => return Ok(((), Some("probe → web on the lab network".into()))),
                Ok(out) => last = out,
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(RETRY).await;
        }
        Err(Error::Invalid(format!("probe could not reach web: {last}")))
    })
    .await?;

    r.step("port", "Lab port reachable from this machine", async {
        let addr = compose(dir, &["port", "web", "80"]).await?;
        let url = format!("http://{}", addr.trim());
        let client = reqwest::Client::builder().timeout(Duration::from_secs(3)).build().map_err(|e| Error::Invalid(e.to_string()))?;
        let mut last = String::new();
        for _ in 0..ANSWER_TRIES {
            match client.get(&url).send().await {
                Ok(res) => match res.text().await {
                    Ok(body) if body.contains(MARKER) => return Ok(((), Some(addr.trim().to_string()))),
                    Ok(body) => last = body,
                    Err(e) => last = e.to_string(),
                },
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(RETRY).await;
        }
        Err(Error::Invalid(format!("{url} did not answer: {last}")))
    })
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_test_lab_serves_its_marker_on_a_loopback_port() {
        let f = super::compose_file();
        assert!(f.contains("image: busybox:1.36") && f.contains("echo cyberctf-selftest-ok") && f.contains("127.0.0.1::80"), "{f}");
    }
}
