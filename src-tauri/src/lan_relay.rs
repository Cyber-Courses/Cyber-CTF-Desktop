//! macOS keeps the third-party tools the app starts off the local network (an app allowed under
//! Privacy & Security > Local Network still can't lend that to Vagrant's Ruby or ovftool: they
//! get "no route to host" to a LAN server the app itself reaches). Apple's own binaries are
//! exempt, and the app process is allowed. So for an ESXi host, Vagrant talks to loopback relays
//! this process runs (SSH and HTTPS to the host), ovftool gets the HTTPS relay's port through a
//! small wrapper, and Vagrant's SSH to the guests goes through Apple's `/usr/bin/nc`.

use std::path::PathBuf;

use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// A loopback port forwarding to a LAN endpoint while it lives.
pub struct Relay {
    pub port: u16,
    task: JoinHandle<()>,
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Listens on 127.0.0.1 (a free port) and pipes every connection to `host:port`.
pub async fn start(host: String, port: u16) -> std::io::Result<Relay> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local = listener.local_addr()?.port();
    let task = tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            let target = (host.clone(), port);
            tokio::spawn(async move {
                if let Ok(mut outbound) = TcpStream::connect(target).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    });
    Ok(Relay { port: local, task })
}

/// A loopback HTTP forward proxy (plain HTTP only), for Vagrant's WinRM to Windows guests: the
/// WinRM client (HTTPClient) follows `http_proxy` and sends absolute-URI requests. Each client
/// connection gets one connection to its target, which WinRM's Negotiate auth needs.
pub async fn start_http_proxy() -> std::io::Result<Relay> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local = listener.local_addr()?.port();
    let task = tokio::spawn(async move {
        while let Ok((inbound, _)) = listener.accept().await {
            tokio::spawn(async move {
                let _ = proxy_connection(inbound).await;
            });
        }
    });
    Ok(Relay { port: local, task })
}

/// The request head's target as (host:port, origin-form path), from an absolute `http://` URI.
fn split_target(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("http://")?;
    let (authority, path) = rest.find('/').map(|i| (&rest[..i], &rest[i..])).unwrap_or((rest, "/"));
    if authority.is_empty() {
        return None;
    }
    let authority = if authority.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) && !authority.ends_with(']') {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    Some((authority, path.to_string()))
}

/// Rewrites one request head for the origin server: origin-form target, no proxy headers.
/// Returns the target and the body length.
fn rewrite_head(head: &str) -> Option<(String, String, usize)> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.splitn(3, ' ');
    let (method, uri, version) = (first.next()?, first.next()?, first.next()?);
    let (target, path) = split_target(uri)?;
    let mut out = format!("{method} {path} {version}\r\n");
    let mut len = 0;
    for line in lines.filter(|l| !l.is_empty()) {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("proxy-connection:") || lower.starts_with("proxy-authorization:") {
            continue;
        }
        if let Some(v) = lower.strip_prefix("content-length:") {
            len = v.trim().parse().ok()?;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    Some((target, out, len))
}

async fn proxy_connection(inbound: TcpStream) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    const BAD_GATEWAY: &[u8] = b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
    let (read_half, write_half) = inbound.into_split();
    let mut reader = BufReader::new(read_half);
    // The client's write half, until the response pump takes it over.
    let mut client_out = Some(write_half);
    let mut upstream: Option<(String, tokio::net::tcp::OwnedWriteHalf, JoinHandle<()>)> = None;
    loop {
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await? == 0 {
                // Client done: let the last response finish.
                if let Some((_, mut to_origin, pump)) = upstream {
                    let _ = to_origin.shutdown().await;
                    let _ = pump.await;
                }
                return Ok(());
            }
            if line == "\r\n" && head.is_empty() {
                continue; // stray CRLF between requests
            }
            head.push_str(&line);
            if line == "\r\n" || head.len() > 64 * 1024 {
                break;
            }
        }
        let parsed = rewrite_head(head.trim_end());
        let Some((target, rewritten, body_len)) = parsed.filter(|(t, ..)| upstream.as_ref().is_none_or(|(u, ..)| u == t)) else {
            // Malformed, or a second origin on one connection: refuse and close.
            if let Some(mut out) = client_out.take() {
                out.write_all(BAD_GATEWAY).await?;
            }
            return Ok(());
        };
        if upstream.is_none() {
            let Ok(stream) = TcpStream::connect(target.as_str()).await else {
                if let Some(mut out) = client_out.take() {
                    out.write_all(BAD_GATEWAY).await?;
                }
                return Ok(());
            };
            let (mut from_origin, to_origin) = stream.into_split();
            let mut out = client_out.take().expect("client write half until the first connect");
            // Responses stream back in order; the client pairs them with its requests.
            let pump = tokio::spawn(async move {
                let _ = tokio::io::copy(&mut from_origin, &mut out).await;
                let _ = out.shutdown().await;
            });
            upstream = Some((target, to_origin, pump));
        }
        let (_, to_origin, _) = upstream.as_mut().expect("connected above");
        to_origin.write_all(rewritten.as_bytes()).await?;
        let mut body = (&mut reader).take(body_len as u64);
        tokio::io::copy(&mut body, to_origin).await?;
    }
}

/// What a relayed run needs kept alive.
pub struct Relayed {
    pub env: Vec<(String, String)>,
    _relays: Vec<Relay>,
}

fn get<'a>(env: &'a [(String, String)], k: &str) -> Option<&'a str> {
    env.iter().rev().find(|(key, _)| key == k).map(|(_, v)| v.as_str())
}

fn set(env: &mut Vec<(String, String)>, k: &str, v: String) {
    env.retain(|(key, _)| key != k);
    env.push((k.to_string(), v));
}

/// The ovftool the wrapper hands over to: the one on PATH (VMware's own bundle as a fallback).
fn real_ovftool() -> Option<String> {
    let from_path = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("ovftool")).find(|f| f.is_file()));
    from_path
        .or_else(|| Some(PathBuf::from("/Applications/VMware Fusion.app/Contents/Library/VMware OVF Tool/ovftool")).filter(|f| f.is_file()))
        .map(|p| p.display().to_string())
}

/// `ovftool` that adds the relay's port to a `vi://…@127.0.0.1` target (the plugin builds the URL
/// from the host name alone, so it can't carry a port) and runs the real one.
const OVFTOOL_WRAPPER: &str = r#"#!/bin/sh
# Written by Cyber CTF: sends ovftool's ESXi target through the app's loopback relay.
n=$#; i=0
while [ "$i" -lt "$n" ]; do
  a=$1; shift
  case "$a" in
    vi://*@127.0.0.1*) a=$(printf '%s' "$a" | /usr/bin/sed -E "s#@127\.0\.0\.1(/|\$)#@127.0.0.1:${CYBERCTF_OVFTOOL_PORT}\1#") ;;
  esac
  set -- "$@" "$a"; i=$((i + 1))
done
exec "$CYBERCTF_REAL_OVFTOOL" "$@"
"#;

fn wrapper_dir() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join("cyberctf-lan-relay");
    std::fs::create_dir_all(&dir)?;
    let f = dir.join("ovftool");
    if std::fs::read_to_string(&f).ok().as_deref() != Some(OVFTOOL_WRAPPER) {
        std::fs::write(&f, OVFTOOL_WRAPPER)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dir)
}

/// For a Vagrant run against an ESXi host on macOS: relays up, the environment pointed at them.
/// Anything else (another tool or OS, no ESXi host in `env`) runs as it was.
pub async fn prepare(program: &str, env: &[(String, String)]) -> Relayed {
    let unchanged = || Relayed { env: env.to_vec(), _relays: Vec::new() };
    if !cfg!(target_os = "macos") || program != "vagrant" {
        return unchanged();
    }
    let Some(host) = get(env, "ESXI_HOSTNAME").or_else(|| get(env, "CYBERCTF_ESXI_HOSTNAME")).filter(|h| !h.is_empty() && *h != "127.0.0.1") else {
        return unchanged();
    };
    let ssh_port = get(env, "ESXI_HOSTPORT").or_else(|| get(env, "CYBERCTF_ESXI_HOSTPORT")).and_then(|p| p.parse().ok()).unwrap_or(22);
    let (Ok(ssh), Ok(https)) = (start(host.to_string(), ssh_port).await, start(host.to_string(), 443).await) else {
        return unchanged();
    };
    let mut out = env.to_vec();
    for k in ["ESXI_HOSTNAME", "CYBERCTF_ESXI_HOSTNAME"] {
        set(&mut out, k, "127.0.0.1".into());
    }
    for k in ["ESXI_HOSTPORT", "CYBERCTF_ESXI_HOSTPORT"] {
        set(&mut out, k, ssh.port.to_string());
    }
    set(&mut out, "ISOLOOM_SSH_PROXY_COMMAND", "/usr/bin/nc %h %p".into());
    // Windows guests: Vagrant's WinRM (plain HTTP to the guest) through the in-app proxy. Only
    // the lowercase http_proxy: HTTPS (box downloads) doesn't read it.
    let winrm = start_http_proxy().await.ok();
    if let Some(p) = &winrm {
        set(&mut out, "http_proxy", format!("http://127.0.0.1:{}", p.port));
        set(&mut out, "no_proxy", "localhost,127.0.0.1".into());
    }
    if let (Some(real), Ok(dir)) = (real_ovftool(), wrapper_dir()) {
        set(&mut out, "CYBERCTF_REAL_OVFTOOL", real);
        set(&mut out, "CYBERCTF_OVFTOOL_PORT", https.port.to_string());
        let path = std::env::var("PATH").unwrap_or_default();
        set(&mut out, "PATH", format!("{}:{path}", dir.display()));
    }
    let mut relays = vec![ssh, https];
    relays.extend(winrm);
    Relayed { env: out, _relays: relays }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn relay_pipes_both_ways() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = echo.accept().await.unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).await.unwrap();
            s.write_all(&b).await.unwrap();
        });
        let relay = start("127.0.0.1".into(), echo_port).await.unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", relay.port)).await.unwrap();
        c.write_all(b"ping").await.unwrap();
        let mut back = [0u8; 4];
        c.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"ping");
    }

    #[tokio::test]
    async fn only_vagrant_with_an_esxi_host_is_relayed() {
        let env = vec![("ESXI_HOSTNAME".to_string(), "10.0.0.5".to_string()), ("ESXI_HOSTPORT".to_string(), "22".to_string())];
        assert_eq!(prepare("docker", &env).await.env, env);
        assert_eq!(prepare("vagrant", &[]).await.env, Vec::<(String, String)>::new());
        let r = prepare("vagrant", &env).await;
        if cfg!(target_os = "macos") {
            assert_eq!(get(&r.env, "ESXI_HOSTNAME"), Some("127.0.0.1"));
            assert_ne!(get(&r.env, "ESXI_HOSTPORT"), Some("22"));
            assert_eq!(get(&r.env, "ISOLOOM_SSH_PROXY_COMMAND"), Some("/usr/bin/nc %h %p"));
            assert!(get(&r.env, "http_proxy").is_some_and(|p| p.starts_with("http://127.0.0.1:")));
        } else {
            assert_eq!(r.env, env);
        }
    }

    #[test]
    fn proxy_heads_become_origin_form() {
        let (t, head, len) =
            rewrite_head("POST http://10.0.0.7:5985/wsman HTTP/1.1\r\nHost: 10.0.0.7:5985\r\nProxy-Connection: Keep-Alive\r\nContent-Length: 12").unwrap();
        assert_eq!(t, "10.0.0.7:5985");
        assert_eq!(head, "POST /wsman HTTP/1.1\r\nHost: 10.0.0.7:5985\r\nContent-Length: 12\r\n\r\n");
        assert_eq!(len, 12);
        assert_eq!(split_target("http://host").unwrap(), ("host:80".into(), "/".into()));
        assert!(rewrite_head("GET /relative HTTP/1.1").is_none());
    }

    #[tokio::test]
    async fn proxy_keeps_one_origin_connection_for_several_requests() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let origin = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = origin.local_addr().unwrap().port();
        // Answers each request on the same connection with the body it got (echo).
        tokio::spawn(async move {
            let (s, _) = origin.accept().await.unwrap();
            let mut r = BufReader::new(s);
            for _ in 0..2 {
                let mut len = 0;
                loop {
                    let mut l = String::new();
                    r.read_line(&mut l).await.unwrap();
                    if let Some(v) = l.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                    if l == "\r\n" {
                        break;
                    }
                }
                let mut body = vec![0; len];
                r.read_exact(&mut body).await.unwrap();
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                r.get_mut().write_all(reply.as_bytes()).await.unwrap();
                r.get_mut().write_all(&body).await.unwrap();
            }
        });
        let proxy = start_http_proxy().await.unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", proxy.port)).await.unwrap();
        for msg in ["first", "second!"] {
            let req = format!("POST http://127.0.0.1:{port}/wsman HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{msg}", msg.len());
            c.write_all(req.as_bytes()).await.unwrap();
            let expect = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{msg}", msg.len());
            let mut got = vec![0; expect.len()];
            c.read_exact(&mut got).await.unwrap();
            assert_eq!(String::from_utf8(got).unwrap(), expect);
        }
    }

    #[test]
    fn wrapper_adds_the_relay_port_to_the_vi_target() {
        let dir = wrapper_dir().unwrap();
        let out = std::process::Command::new(dir.join("ovftool"))
            .args(["--noSSLVerify", "box.vmx", "vi://root:p%40ss@127.0.0.1/pool"])
            .env("CYBERCTF_OVFTOOL_PORT", "40443")
            .env("CYBERCTF_REAL_OVFTOOL", "/bin/echo")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "--noSSLVerify box.vmx vi://root:p%40ss@127.0.0.1:40443/pool");
    }
}
