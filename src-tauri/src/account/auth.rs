//! Login with cyber-auth: OAuth authorization code + PKCE (RFC 7636) through the
//! system browser and a loopback redirect (RFC 8252). Tokens live in the OS
//! keychain and never reach the webview; API calls go through `api.rs`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::config;
use crate::error::{Error, Result};

const SCOPES: &str = "openid profile email offline_access";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Deserialize, Clone)]
struct Session {
    access_token: String,
    refresh_token: Option<String>,
    /// Seconds since epoch.
    expires_at: u64,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    logged_in: bool,
    name: Option<String>,
    email: Option<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_b64(bytes: usize) -> String {
    let buf: Vec<u8> = (0..bytes).map(|_| rand::random::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(buf)
}

/// S256 code challenge for a verifier (RFC 7636 §4.2).
pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

// --- session storage ------------------------------------------------------
// Release builds keep the session in the OS keychain. Dev builds keep it in a file
// instead: every `tauri dev` rebuild is an unsigned, different binary, so the keychain
// re-prompts for access on each run ("...wants to use your confidential information").
// A file avoids that churn while developing. (A signed release build, with a stable code
// signature + keychain-access-group, prompts at most once.)

#[cfg(not(debug_assertions))]
fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(config::KEYCHAIN_SERVICE, "session").map_err(|e| Error::Invalid(format!("keychain: {e}")))
}

#[cfg(debug_assertions)]
fn dev_session_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(std::path::PathBuf::from(home).join(".cyberctf").join("dev-session.json"))
}

fn load_session() -> Option<Session> {
    #[cfg(debug_assertions)]
    {
        let raw = std::fs::read_to_string(dev_session_path()?).ok()?;
        serde_json::from_str(&raw).ok()
    }
    #[cfg(not(debug_assertions))]
    {
        let raw = entry().ok()?.get_password().ok()?;
        serde_json::from_str(&raw).ok()
    }
}

fn save_session(session: &Session) -> Result<()> {
    let raw = serde_json::to_string(session).map_err(|e| Error::Invalid(e.to_string()))?;
    #[cfg(debug_assertions)]
    {
        let path = dev_session_path().ok_or_else(|| Error::Invalid("no home directory".into()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, raw)?;
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        entry()?.set_password(&raw).map_err(|e| Error::Invalid(format!("keychain: {e}")))
    }
}

fn clear_session() {
    #[cfg(debug_assertions)]
    {
        if let Some(path) = dev_session_path() {
            let _ = std::fs::remove_file(path);
        }
    }
    #[cfg(not(debug_assertions))]
    {
        if let Ok(e) = entry() {
            let _ = e.delete_credential();
        }
    }
}

// --- tokens ---------------------------------------------------------------

/// Display claims from the ID token. It comes straight from the token endpoint
/// over TLS, so its signature is not re-verified here; it is never used for
/// authorization (the API verifies the access token itself).
fn id_token_profile(id_token: &str) -> (Option<String>, Option<String>) {
    let claims = id_token.split('.').nth(1).and_then(|p| URL_SAFE_NO_PAD.decode(p).ok()).and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    match claims {
        Some(c) => (c.get("name").and_then(|v| v.as_str()).map(str::to_string), c.get("email").and_then(|v| v.as_str()).map(str::to_string)),
        None => (None, None),
    }
}

async fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse> {
    let res = reqwest::Client::new()
        .post(format!("{}/oauth2/token", config::auth_base()))
        .form(form)
        .send()
        .await
        .map_err(|e| Error::Invalid(format!("token request failed: {e}")))?;
    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(Error::Invalid(format!("token request rejected: {body}")));
    }
    res.json().await.map_err(|e| Error::Invalid(format!("invalid token response: {e}")))
}

fn session_from(tokens: TokenResponse, previous: Option<&Session>) -> Session {
    let (name, email) = match tokens.id_token.as_deref() {
        Some(t) => id_token_profile(t),
        None => (previous.and_then(|p| p.name.clone()), previous.and_then(|p| p.email.clone())),
    };
    Session {
        access_token: tokens.access_token,
        // Refresh tokens may rotate; keep the old one if none is returned.
        refresh_token: tokens.refresh_token.or_else(|| previous.and_then(|p| p.refresh_token.clone())),
        expires_at: now() + tokens.expires_in.unwrap_or(3600),
        name,
        email,
    }
}

/// A valid access token for CyberBackend, refreshed if it expires within a minute.
pub async fn access_token() -> Result<String> {
    let session = load_session().ok_or_else(|| Error::Invalid("not logged in".into()))?;
    if session.expires_at > now() + 60 {
        return Ok(session.access_token);
    }
    let refresh = session.refresh_token.clone().ok_or_else(|| Error::Invalid("session expired, log in again".into()))?;
    let (client_id, api) = (config::client_id(), config::api_url());
    let tokens = token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id), ("resource", &api)])
        .await
        .inspect_err(|_| clear_session())?;
    let renewed = session_from(tokens, Some(&session));
    save_session(&renewed)?;
    Ok(renewed.access_token)
}

// --- login ----------------------------------------------------------------

async fn bind_loopback() -> Result<(TcpListener, u16)> {
    for port in config::REDIRECT_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            return Ok((listener, port));
        }
    }
    Err(Error::Invalid("no free login callback port (47290-47292)".into()))
}

/// Waits for the browser's redirect and returns (code, state) from its query.
async fn receive_callback(listener: TcpListener) -> Result<(String, String)> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request.split_whitespace().nth(1).unwrap_or("");
        let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
        if url.path() != "/callback" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            continue;
        }
        let param = |k: &str| url.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned());
        let failed = param("error").is_some();
        let body = if failed {
            "Login was cancelled or failed. You can close this tab and try again from Cyber CTF."
        } else {
            "You are logged in. You can close this tab and return to Cyber CTF."
        };
        // A button that reopens the app (the cyberctf:// scheme brings the running window to the
        // front) and then closes this tab. window.close() only works for a script-opened tab, so
        // it's best effort; the deep link raises the app either way, and the text covers the rest.
        let label = if failed { "Back to Cyber CTF" } else { "Return to Cyber CTF" };
        let page = format!(
            "<!doctype html><meta charset=utf-8><title>Cyber CTF</title>\
             <body style=\"font-family:system-ui;background:#0a0a0a;color:#e5e5e5;display:grid;place-items:center;height:100vh;margin:0\">\
             <div style=\"text-align:center;max-width:30rem;padding:1.5rem\">\
             <p style=\"line-height:1.5\">{body}</p>\
             <button id=\"r\" style=\"margin-top:1rem;padding:.6rem 1.2rem;border:0;border-radius:.5rem;background:#7c5cff;color:#fff;font:inherit;font-weight:600;cursor:pointer\">{label}</button>\
             </div>\
             <script>var b=document.getElementById('r');function go(){{location.href='cyberctf://';setTimeout(function(){{window.open('','_self');window.close();}},300);}}b.addEventListener('click',go);</script>"
        );
        let _ = stream
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len())
                    .as_bytes(),
            )
            .await;
        if let Some(error) = param("error") {
            return Err(Error::Invalid(format!("login failed: {error}")));
        }
        return match (param("code"), param("state")) {
            (Some(code), Some(state)) => Ok((code, state)),
            _ => Err(Error::Invalid("login callback without code".into())),
        };
    }
}

#[tauri::command]
pub async fn auth_login(app: AppHandle) -> Result<AuthStatus> {
    let (listener, port) = bind_loopback().await?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_b64(32);
    let state = random_b64(16);
    let (client_id, api) = (config::client_id(), config::api_url());

    let mut authorize = url::Url::parse(&format!("{}/oauth2/authorize", config::auth_base())).map_err(|e| Error::Invalid(e.to_string()))?;
    authorize
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", SCOPES)
        .append_pair("state", &state)
        .append_pair("code_challenge", &code_challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", &api);
    app.opener().open_url(authorize.as_str(), None::<&str>).map_err(|e| Error::Invalid(format!("could not open the browser: {e}")))?;

    let (code, returned_state) =
        tokio::time::timeout(LOGIN_TIMEOUT, receive_callback(listener)).await.map_err(|_| Error::Invalid("login timed out".into()))??;
    if returned_state != state {
        return Err(Error::Invalid("login state mismatch".into()));
    }

    let tokens = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect_uri),
        ("client_id", &client_id),
        ("code_verifier", &verifier),
        ("resource", &api),
    ])
    .await?;
    let session = session_from(tokens, None);
    save_session(&session)?;
    Ok(AuthStatus { logged_in: true, name: session.name, email: session.email })
}

#[tauri::command]
pub fn auth_status() -> AuthStatus {
    match load_session() {
        Some(s) => AuthStatus { logged_in: true, name: s.name, email: s.email },
        None => AuthStatus { logged_in: false, name: None, email: None },
    }
}

#[tauri::command]
pub fn auth_logout() {
    clear_session();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_base64url_sha256_of_the_verifier() {
        // Cross-checked with:
        // printf '%s' <verifier> | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='
        assert_eq!(code_challenge("dBjftJeZ4CVP-mJ0kKTiKjKNRKG8W9lLr1J-HQ8YP4U"), "ryJ-YCh3KzrVMsHxmF-ZbP5xcAvmtebmf63k9UP0L3k");
    }

    #[test]
    fn verifiers_are_long_and_unique() {
        let (a, b) = (random_b64(32), random_b64(32));
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
    }

    #[test]
    fn reads_display_claims_from_id_token() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"u1","name":"Camille","email":"c@cyberctf.fr"}"#);
        let (name, email) = id_token_profile(&format!("h.{payload}.s"));
        assert_eq!(name.as_deref(), Some("Camille"));
        assert_eq!(email.as_deref(), Some("c@cyberctf.fr"));
        assert_eq!(id_token_profile("garbage"), (None, None));
    }
}
