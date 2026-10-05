//! Launcher agent: "bring your own compute". Once the player is logged in, this machine
//! registers itself with CyberBackend (keyed by a stable per-install id so several
//! machines are distinct), heartbeats so it shows as online, and polls for the player's
//! launch requests. When one arrives it claims it, runs the lab locally, and reports back.
//! See doc/architecture/LAB-LAUNCHER-CHANNEL.md.
//!
//! Phase 2a (here): presence + claim-and-run. The interactive surface (loopback
//! co-location server, relay tunnel, terminal / noVNC) is Phase 2b.

use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::account::api;
use crate::account::auth;
use crate::account::colocation;
use crate::error::{Error, Result};
use crate::labs;
use crate::runtime::server;

/// A stable identifier for this installation, generated once and kept in the app data
/// dir. It is the merge key for the agent, so reinstalling re-registers the same machine
/// and two machines never collide even when they share a display name.
fn install_id(app: &AppHandle) -> Result<String> {
    let path = app.path().app_data_dir().map_err(|e| Error::Invalid(e.to_string()))?.join("install-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let id: String = (0..16).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &id)?;
    Ok(id)
}

/// A human label for this machine (editable server-side later). Not an identifier.
fn machine_name() -> String {
    if let Ok(n) = std::env::var("CYBERCTF_AGENT_NAME")
        && !n.trim().is_empty()
    {
        return n.trim().to_string();
    }
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok().filter(|s| !s.trim().is_empty());
    let os = match std::env::consts::OS {
        "macos" => "Mac",
        "windows" => "PC",
        "linux" => "Linux",
        other => other,
    };
    match user {
        Some(u) => format!("{u}'s {os}"),
        None => format!("Cyber CTF {os}"),
    }
}

fn arch() -> &'static str {
    std::env::consts::ARCH
}

/// What this machine can run. Docker for now; VM providers are detected later.
fn capabilities() -> Vec<String> {
    vec!["docker".to_string()]
}

/// Upserts this machine as the player's launcher agent and returns the server agent id.
async fn register(app: &AppHandle) -> Result<String> {
    let data = api::graphql(
        "mutation ($i: ID!, $n: String!, $c: [String!]!, $a: String, $t: [LaunchTargetInput!]) { registerLauncher(installId: $i, name: $n, capabilities: $c, arch: $a, targets: $t) { id } }",
        json!({ "i": install_id(app)?, "n": machine_name(), "c": capabilities(), "a": arch(), "t": server::launch_targets(app) }),
        true,
    )
    .await?;
    data["registerLauncher"]["id"].as_str().map(String::from).ok_or_else(|| Error::Invalid("registerLauncher returned no id".into()))
}

/// Keep-alive, re-reporting the targets so hosts added since registering show on the website.
async fn heartbeat(app: &AppHandle, agent_id: &str) -> Result<()> {
    api::graphql(
        "mutation ($id: ID!, $t: [LaunchTargetInput!]) { launcherHeartbeat(agentId: $id, targets: $t) { id } }",
        json!({ "id": agent_id, "t": server::launch_targets(app) }),
        true,
    )
    .await
    .map(|_| ())
}

/// Attack box for labs launched from the website onto a host: the default image (the
/// per-machine setting lives in the webview). Matches DEFAULT_ATTACK_IMAGE in settings.ts.
const DEFAULT_ATTACK_IMAGE: &str = "cyberctf/attack-box";

#[derive(Default)]
struct Progress<'a> {
    local_url: Option<&'a str>,
    control_url: Option<&'a str>,
    token: Option<&'a str>,
    nonce: Option<&'a str>,
    message: Option<&'a str>,
}

async fn update_state(session_id: &str, state: &str, p: Progress<'_>) -> Result<()> {
    api::graphql(
        "mutation ($id: ID!, $s: LabSessionState!, $u: String, $c: String, $t: String, $n: String, $m: String) { updateLabSession(sessionId: $id, state: $s, localUrl: $u, controlUrl: $c, localToken: $t, coLocationNonce: $n, message: $m) { id } }",
        json!({ "id": session_id, "s": state, "u": p.local_url, "c": p.control_url, "t": p.token, "n": p.nonce, "m": p.message }),
        true,
    )
    .await
    .map(|_| ())
}

fn random_hex() -> String {
    (0..16).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

/// Claims one pending session and runs its lab on this machine.
async fn claim_and_run(app: &AppHandle, session_id: &str) -> Result<()> {
    let data = api::graphql(
        "mutation ($id: ID!) { claimLaunch(sessionId: $id) { labId runtime repository commit target env { name value } } }",
        json!({ "id": session_id }),
        true,
    )
    .await?;
    update_state(session_id, "PULLING", Progress { message: Some("Preparing the lab on your machine"), ..Default::default() }).await?;
    // Run the lab locally and report where its target is reachable, plus a loopback control
    // endpoint + one-time token/nonce so the website can verify co-location before trusting
    // the 127.0.0.1 URL. The relay path for a remote/headless agent is the next step.
    // Where to run it: the target picked on the website (one of this launcher's hosts or
    // cloud accounts); else VM labs go to the default server host and Docker labs run here.
    let host = match data["claimLaunch"]["target"].as_str() {
        Some(target) => Some(
            server::host_name(app, target).map(|_| target.to_string()).ok_or_else(|| Error::Invalid("that host is no longer set up in the launcher".into()))?,
        ),
        None => (data["claimLaunch"]["runtime"] == "VM").then(|| server::default_host(app)).flatten(),
    };
    let image = host.as_ref().map(|_| DEFAULT_ATTACK_IMAGE);
    let url = labs::run(app, data["claimLaunch"].clone(), None, host.as_deref(), image, |_line: String| {}).await?;
    let running_on = host.as_deref().and_then(|h| server::host_name(app, h)).map(|n| format!("Running on {n}"));
    let token = random_hex();
    let nonce = random_hex();
    let control_url = colocation::serve(token.clone(), nonce.clone()).await.ok().map(|port| format!("http://127.0.0.1:{port}"));
    update_state(
        session_id,
        "RUNNING",
        Progress {
            local_url: url.as_deref(),
            control_url: control_url.as_deref(),
            token: Some(&token),
            nonce: Some(&nonce),
            message: Some(running_on.as_deref().unwrap_or("Running on your machine")),
        },
    )
    .await?;
    // A lab launched from the website just started here: let the player know on this machine.
    let _ = app.notification().builder().title("Lab running").body("A lab launched from the website is now running on this machine.").show();
    Ok(())
}

/// Picks up and runs every pending launch aimed at this agent.
async fn poll_once(app: &AppHandle, agent_id: &str) -> Result<()> {
    let data = api::graphql("query ($a: ID) { myPendingLaunches(agentId: $a) { id } }", json!({ "a": agent_id }), true).await?;
    if let Some(sessions) = data["myPendingLaunches"].as_array() {
        for session in sessions {
            if let Some(sid) = session.get("id").and_then(Value::as_str)
                && let Err(e) = claim_and_run(app, sid).await
            {
                log::warn!("lab session {sid} failed: {e}");
                let _ = update_state(sid, "FAILED", Progress { message: Some(&e.to_string()), ..Default::default() }).await;
            }
        }
    }
    Ok(())
}

/// Starts the background agent: waits for login, registers, then heartbeats (~30s) and
/// polls for launches (~6s) for as long as the app runs.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        while auth::access_token().await.is_err() {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        let agent_id = loop {
            match register(&app).await {
                Ok(id) => break id,
                Err(e) => {
                    log::warn!("registerLauncher failed, retrying: {e}");
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            }
        };
        log::info!("launcher agent online: {agent_id}");
        // Heartbeat on its own task: claiming and running a lab can block for a long time (a
        // cloud launch waits on terraform apply, up to tens of minutes), and the machine must
        // keep reporting that it's online for the whole launch, not drop offline while busy.
        {
            let app = app.clone();
            let agent_id = agent_id.clone();
            tokio::spawn(async move {
                loop {
                    if auth::access_token().await.is_ok() {
                        let _ = heartbeat(&app, &agent_id).await;
                    }
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            });
        }
        loop {
            if auth::access_token().await.is_ok() {
                let _ = poll_once(&app, &agent_id).await;
            }
            tokio::time::sleep(Duration::from_secs(6)).await;
        }
    });
}

/// This machine's identity, for the UI ("running as ...").
#[tauri::command]
pub fn agent_info(app: AppHandle) -> Result<Value> {
    Ok(json!({ "installId": install_id(&app)?, "name": machine_name(), "arch": arch(), "capabilities": capabilities() }))
}
