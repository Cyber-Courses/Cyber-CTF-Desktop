//! Service endpoints. Defaults point at production; each can be overridden at
//! build time (option_env!) or at run time (env var of the same name), e.g. to
//! run the whole flow against a local cyber-auth and CyberBackend.

fn setting(name: &str, build_time: Option<&'static str>, default: &'static str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| build_time.unwrap_or(default).to_string())
}

/// Better Auth base, e.g. https://www.cyberauth.co/api/auth
pub fn auth_base() -> String {
    setting("CYBERCTF_AUTH_BASE", option_env!("CYBERCTF_AUTH_BASE"), "https://www.cyberauth.co/api/auth")
}

/// CyberBackend origin; also the OAuth `resource` (token audience).
pub fn api_url() -> String {
    setting("CYBERBACKEND_URL", option_env!("CYBERBACKEND_URL"), "https://cyberbackend.com")
}

/// Public OAuth client registered in cyber-auth for the launcher (PKCE, no secret).
pub fn client_id() -> String {
    setting("CYBERCTF_CLIENT_ID", option_env!("CYBERCTF_CLIENT_ID"), "MORSNcedpYSLupYIwbaKyHIXdGgVhanC")
}

/// Loopback redirect ports, all registered on the OAuth client as
/// http://127.0.0.1:<port>/callback (cyber-auth matches redirect URIs exactly).
pub const REDIRECT_PORTS: [u16; 3] = [47290, 47291, 47292];

// Used by the keychain-backed session store in release builds (dev stores a file).
#[cfg_attr(debug_assertions, allow(dead_code))]
pub const KEYCHAIN_SERVICE: &str = "org.cyberctf.desktop";
