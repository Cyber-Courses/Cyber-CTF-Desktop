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
    keyring::Entry::new(config::KEYCHAIN_SERVICE, "session").map_err(keychain_error)
}

/// The keychain failing is the common Linux case: no Secret Service (GNOME Keyring, KWallet)
/// running, or it is locked. Say what to do; the raw error stays in parentheses for support.
#[cfg(not(debug_assertions))]
fn keychain_error(e: keyring::Error) -> Error {
    Error::Invalid(format!(
        "Cyber CTF couldn't use the system keychain to keep your session. On Linux, start and unlock a keyring \
         (GNOME Keyring or KWallet) and sign in again. ({e})"
    ))
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
        entry()?.set_password(&raw).map_err(keychain_error)
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
        expires_at: now().saturating_add(tokens.expires_in.unwrap_or(3600)),
        name,
        email,
    }
}

/// What a call needing the account says when there is no session (never signed in, signed out,
/// or the keychain lost it). The app matches on "signed out" to flip to its signed-out state.
pub const SIGNED_OUT: &str = "You're signed out. Sign in again to continue.";

/// A valid access token for CyberBackend, refreshed if it expires within a minute.
///
/// One refresh at a time: at start-up the agent and the first API calls all find the same
/// expired token and would each send the same refresh token. With refresh-token rotation the
/// second one is rejected (`invalid_grant`), and that used to wipe the session: the app came
/// back signed out after every restart past the token's lifetime. Callers queue here and re-read
/// the session once they hold the lock, so the first refresh serves them all.
pub async fn access_token() -> Result<String> {
    static REFRESH: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let session = load_session().ok_or_else(|| Error::Invalid(SIGNED_OUT.into()))?;
    if session.expires_at > now() + 60 {
        return Ok(session.access_token);
    }
    let _one_at_a_time = REFRESH.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let session = load_session().ok_or_else(|| Error::Invalid(SIGNED_OUT.into()))?;
    if session.expires_at > now() + 60 {
        return Ok(session.access_token);
    }
    let refresh = session.refresh_token.clone().ok_or_else(|| Error::Invalid("Your session expired: you're signed out. Sign in again to continue.".into()))?;
    let (client_id, api) = (config::client_id(), config::api_url());
    let tokens = match token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id), ("resource", &api)]).await {
        Ok(tokens) => tokens,
        Err(e) => {
            // Only drop the session when the server explicitly rejected the refresh token
            // (OAuth `invalid_grant`). On a transient failure (network, 5xx) keep it, so a blip
            // near expiry doesn't log the user out and stop the background agent.
            if e.to_string().contains("invalid_grant") {
                clear_session();
            }
            return Err(e);
        }
    };
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
    app.opener()
        .open_url(authorize.as_str(), None::<&str>)
        .map_err(|_| Error::Invalid("No browser opened for sign-in. Set a default web browser for this account and try again.".into()))?;

    let (code, returned_state) = tokio::time::timeout(LOGIN_TIMEOUT, receive_callback(listener))
        .await
        .map_err(|_| Error::Invalid("Sign-in wasn't finished within 5 minutes, so it was cancelled. Try again.".into()))??;
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
    // Signed in at cyber-auth, but the session can't be kept: say so, so the app doesn't look
    // like the login was never accepted.
    save_session(&session).map_err(|e| Error::Invalid(format!("You signed in, but the session wasn't saved. {e}")))?;
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

    fn tokens(access: &str, refresh: Option<&str>, id: Option<&str>, expires_in: Option<u64>) -> TokenResponse {
        TokenResponse { access_token: access.to_string(), refresh_token: refresh.map(str::to_string), id_token: id.map(str::to_string), expires_in }
    }

    fn session(refresh: Option<&str>, name: Option<&str>, email: Option<&str>) -> Session {
        Session {
            access_token: "old-access".into(),
            refresh_token: refresh.map(str::to_string),
            expires_at: 0,
            name: name.map(str::to_string),
            email: email.map(str::to_string),
        }
    }

    #[test]
    fn session_from_carries_over_the_refresh_token_when_none_returned() {
        let prev = session(Some("keep-me"), None, None);
        // Refresh grant that returns no new refresh token: keep the previous one.
        let s = session_from(tokens("new-access", None, None, Some(3600)), Some(&prev));
        assert_eq!(s.access_token, "new-access");
        assert_eq!(s.refresh_token.as_deref(), Some("keep-me"));
        // A rotated refresh token replaces the old one.
        let s = session_from(tokens("new-access", Some("rotated"), None, Some(3600)), Some(&prev));
        assert_eq!(s.refresh_token.as_deref(), Some("rotated"));
    }

    #[test]
    fn session_from_keeps_previous_profile_without_a_new_id_token() {
        let prev = session(Some("r"), Some("Camille"), Some("c@cyberctf.fr"));
        // No id_token in a refresh response: display name/email carry over.
        let s = session_from(tokens("a", None, None, Some(60)), Some(&prev));
        assert_eq!(s.name.as_deref(), Some("Camille"));
        assert_eq!(s.email.as_deref(), Some("c@cyberctf.fr"));
        // A fresh id_token overrides the carried-over profile.
        let payload = URL_SAFE_NO_PAD.encode(br#"{"name":"Noor","email":"n@cyberctf.fr"}"#);
        let s = session_from(tokens("a", None, Some(&format!("h.{payload}.s")), Some(60)), Some(&prev));
        assert_eq!(s.name.as_deref(), Some("Noor"));
        assert_eq!(s.email.as_deref(), Some("n@cyberctf.fr"));
    }

    #[test]
    fn session_from_defaults_expiry_and_has_no_previous_on_first_login() {
        // First login (no previous session) and a missing expires_in: default 3600s lifetime.
        let before = now();
        let s = session_from(tokens("a", Some("r"), None, None), None);
        assert!(s.expires_at >= before + 3600);
        assert_eq!(s.refresh_token.as_deref(), Some("r"));
        assert_eq!(s.name, None);
        assert_eq!(s.email, None);
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
