//! The loopback redirect (RFC 8252): a one-shot local server the browser comes back to after
//! sign-in, and the page it shows there.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::config;
use crate::error::{Error, Result};

/// The first free loopback port registered on the OAuth client.
pub(super) async fn bind_loopback() -> Result<(TcpListener, u16)> {
    for port in config::REDIRECT_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            return Ok((listener, port));
        }
    }
    Err(Error::Invalid("no free login callback port (47290-47292)".into()))
}

/// The page the browser shows once Cyber Auth sends the player back: the family look (the launcher's
/// dark tokens, light when the browser is), the app mark, and a button back to the app.
fn login_page(ok: bool) -> String {
    const TEMPLATE: &str = include_str!("login-page.html");
    const LOGO: &str = include_str!("../../../../public/logo-mark.svg");
    const CHECK: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>"#;
    const CROSS: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>"#;
    // The SVG file starts with an XML prolog, which can't sit inside HTML.
    let logo = LOGO.find("<svg").map_or("", |i| &LOGO[i..]);
    let (state, icon, title, body, button) = if ok {
        (
            "ok",
            CHECK,
            "You're signed in",
            "Cyber CTF is connected to your account. Labs you launch from the website now run on this machine.",
            "Return to Cyber CTF",
        )
    } else {
        ("error", CROSS, "Sign-in didn't finish", "It was cancelled or the link expired. Go back to Cyber CTF and press Sign in again.", "Back to Cyber CTF")
    };
    TEMPLATE
        .replace("__STATE__", state)
        .replace("__LOGO__", logo)
        .replace("__ICON__", icon)
        .replace("__TITLE__", title)
        .replace("__BODY__", body)
        .replace("__BUTTON__", button)
}

/// The redirect's URL, from the raw request's target (`GET /callback?code=… HTTP/1.1`).
fn request_url(request: &str) -> Option<url::Url> {
    let target = request.split_whitespace().nth(1).unwrap_or("");
    url::Url::parse(&format!("http://127.0.0.1{target}")).ok()
}

/// What a callback URL says: (code, state), or why sign-in failed.
fn outcome(url: &url::Url) -> Result<(String, String)> {
    let param = |k: &str| url.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned());
    if let Some(error) = param("error") {
        return Err(Error::Invalid(format!("login failed: {error}")));
    }
    match (param("code"), param("state")) {
        (Some(code), Some(state)) => Ok((code, state)),
        _ => Err(Error::Invalid("login callback without code".into())),
    }
}

fn html_response(page: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len())
}

/// Waits for the browser's redirect and returns (code, state) from its query.
pub(super) async fn receive(listener: TcpListener) -> Result<(String, String)> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await?;
        let Some(url) = request_url(&String::from_utf8_lossy(&buf[..n])) else { continue };
        if url.path() != "/callback" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            continue;
        }
        let failed = url.query_pairs().any(|(key, _)| key == "error");
        let _ = stream.write_all(html_response(&login_page(!failed)).as_bytes()).await;
        return outcome(&url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_callback_gives_the_code_and_state_or_the_error() {
        let url = request_url("GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        assert_eq!(url.path(), "/callback");
        assert_eq!(outcome(&url).unwrap(), ("abc".to_string(), "xyz".to_string()));
        let denied = request_url("GET /callback?error=access_denied&state=xyz HTTP/1.1").unwrap();
        assert_eq!(outcome(&denied).unwrap_err().to_string(), "login failed: access_denied");
        let bare = request_url("GET /callback HTTP/1.1").unwrap();
        assert_eq!(outcome(&bare).unwrap_err().to_string(), "login callback without code");
        assert_eq!(request_url("GET /favicon.ico HTTP/1.1").unwrap().path(), "/favicon.ico");
    }

    #[test]
    fn the_login_page_says_how_it_went() {
        let ok = login_page(true);
        assert!(ok.contains("You're signed in") && !ok.contains("__"), "placeholders left in the page");
        assert!(login_page(false).contains("Sign-in didn't finish"));
        assert!(html_response("hi").ends_with("Content-Length: 2\r\nConnection: close\r\n\r\nhi"));
    }
}
