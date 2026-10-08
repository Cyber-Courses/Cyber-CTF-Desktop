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
    if let (Some(real), Ok(dir)) = (real_ovftool(), wrapper_dir()) {
        set(&mut out, "CYBERCTF_REAL_OVFTOOL", real);
        set(&mut out, "CYBERCTF_OVFTOOL_PORT", https.port.to_string());
        let path = std::env::var("PATH").unwrap_or_default();
        set(&mut out, "PATH", format!("{}:{path}", dir.display()));
    }
    Relayed { env: out, _relays: vec![ssh, https] }
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
        } else {
            assert_eq!(r.env, env);
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
