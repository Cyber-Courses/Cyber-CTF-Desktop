//! A tiny loopback control server for the co-location probe (see
//! doc/architecture/LAB-LAUNCHER-CHANNEL.md). When a lab is launched, the website must
//! decide whether this launcher is on the same machine as the browser before it trusts a
//! `127.0.0.1` lab URL. It does that by fetching `GET /health?token=<one-time token>` here
//! and checking the returned nonce. We bind loopback-only, require the token, and echo an
//! allowed Origin so only the site can read the response.

use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{Error, Result};

/// Site origins allowed to read the probe. Loopback origins (dev) are allowed too.
const ALLOWED_ORIGINS: [&str; 4] = ["https://www.cybercourses.com", "https://cybercourses.com", "https://www.cyberctf.org", "https://cyberctf.org"];

fn origin_allowed(origin: &str) -> bool {
    ALLOWED_ORIGINS.contains(&origin)
        || origin.starts_with("http://localhost")
        || origin.starts_with("http://127.0.0.1")
        || origin.starts_with("https://localhost")
}

fn header<'a>(req: &'a str, name: &str) -> Option<&'a str> {
    req.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// Builds the HTTP response for a raw request. Pure, so it is unit-tested directly.
fn build_response(req: &str, token: &str, nonce: &str) -> String {
    let request_line = req.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let origin = header(req, "origin").unwrap_or("");

    let reply = |status: &str, body: &str| -> String {
        let cors = if origin_allowed(origin) && !origin.is_empty() { format!("Access-Control-Allow-Origin: {origin}\r\n") } else { String::new() };
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n{cors}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    };

    if method == "OPTIONS" {
        return reply("204 No Content", "");
    }
    if method != "GET" {
        return reply("405 Method Not Allowed", "{\"error\":\"method\"}");
    }
    if path != "/health" {
        return reply("404 Not Found", "{\"error\":\"not_found\"}");
    }
    let given = query.split('&').find_map(|kv| kv.strip_prefix("token=")).unwrap_or("");
    if given != token {
        return reply("403 Forbidden", "{\"error\":\"forbidden\"}");
    }
    reply("200 OK", &format!("{{\"nonce\":\"{nonce}\"}}"))
}

/// Starts the control server on a free loopback port and returns the port. It runs for the
/// life of the process; a new launch starts a new one.
pub async fn serve(token: String, nonce: String) -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(Error::Io)?;
    let port = listener.local_addr().map_err(Error::Io)?.port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _addr)): std::result::Result<(_, SocketAddr), _> = listener.accept().await else { continue };
            let (token, nonce) = (token.clone(), nonce.clone());
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let resp = build_response(&req, &token, &nonce);
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::build_response;

    fn get(path: &str, origin: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {origin}\r\n\r\n")
    }

    #[test]
    fn returns_the_nonce_only_with_the_right_token_and_echoes_allowed_origin() {
        let ok = build_response(&get("/health?token=secret", "https://www.cybercourses.com"), "secret", "abc123");
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert!(ok.contains("\"nonce\":\"abc123\""));
        assert!(ok.contains("Access-Control-Allow-Origin: https://www.cybercourses.com"));
    }

    #[test]
    fn rejects_a_wrong_token() {
        let bad = build_response(&get("/health?token=nope", "https://www.cybercourses.com"), "secret", "abc123");
        assert!(bad.starts_with("HTTP/1.1 403"));
        assert!(!bad.contains("abc123"));
    }

    #[test]
    fn does_not_echo_a_foreign_origin() {
        let r = build_response(&get("/health?token=secret", "https://evil.example.com"), "secret", "abc123");
        assert!(r.starts_with("HTTP/1.1 200"));
        assert!(!r.contains("Access-Control-Allow-Origin"));
    }

    #[test]
    fn unknown_path_is_404() {
        assert!(build_response(&get("/secrets", "https://cybercourses.com"), "secret", "n").starts_with("HTTP/1.1 404"));
    }
}
