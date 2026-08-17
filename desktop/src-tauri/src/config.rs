//! Shell-owned state: install paths, the persisted port, and the per-install
//! server secret. Nothing here belongs to the runtime — everything the *app*
//! keeps lives in `/data` inside the distro.

use serde::{Deserialize, Serialize};

/// Persisted in `%APPDATA%\Cody\config.json`; a collision moves it.
pub const DEFAULT_PORT: u16 = 30179;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for Config {
    fn default() -> Self {
        Self { port: DEFAULT_PORT }
    }
}

pub fn parse_config(body: &str) -> Config {
    serde_json::from_str(body).unwrap_or_default()
}

/// 32 bytes of entropy rendered as lowercase hex. Used as `CODY_PASSWORD`,
/// which the server compares in constant time.
pub fn encode_secret(bytes: &[u8; 32]) -> String {
    crate::rootfs::hex(bytes)
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::net::TcpListener;
    use std::path::PathBuf;

    fn env_dir(var: &str, fallback: &str) -> PathBuf {
        std::env::var_os(var)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(fallback))
            .join("Cody")
    }

    /// Roaming: small, user-scoped, and the natural home for the port and the
    /// secret.
    pub fn app_dir() -> PathBuf {
        env_dir("APPDATA", r"C:\Users\Public\AppData\Roaming")
    }

    /// Non-roaming: multi-gigabyte artifacts must never sync.
    pub fn local_dir() -> PathBuf {
        env_dir("LOCALAPPDATA", r"C:\Users\Public\AppData\Local")
    }

    /// WSL refuses to run a distro off a non-system drive, and
    /// `%LOCALAPPDATA%` is on the system drive by definition.
    pub fn distro_dir() -> PathBuf {
        local_dir().join("wsl").join("cody")
    }

    pub fn downloads_dir() -> PathBuf {
        local_dir().join("downloads")
    }

    pub fn backups_dir() -> PathBuf {
        local_dir().join("backups")
    }

    pub fn updates_dir() -> PathBuf {
        local_dir().join("updates")
    }

    fn config_path() -> PathBuf {
        app_dir().join("config.json")
    }

    fn secret_path() -> PathBuf {
        app_dir().join("credentials.bin")
    }

    pub fn load() -> Config {
        std::fs::read_to_string(config_path())
            .map(|body| parse_config(&body))
            .unwrap_or_default()
    }

    pub fn save(config: &Config) {
        let path = config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string_pretty(config) {
            let _ = std::fs::write(path, body);
        }
    }

    /// Prefer the remembered port, fall back to whatever the OS hands out.
    /// Bound on `127.0.0.1` so the probe itself never opens a listener the
    /// network can see.
    pub fn pick_port(preferred: u16) -> u16 {
        if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
            return preferred;
        }
        TcpListener::bind(("127.0.0.1", 0))
            .ok()
            .and_then(|l| l.local_addr().ok())
            .map(|addr| addr.port())
            .unwrap_or(preferred)
    }

    /// The secret is generated once per install and never leaves the machine.
    /// DPAPI ties the file to the Windows account; if DPAPI is unavailable
    /// the secret is stored as-is under `%APPDATA%`, which is already
    /// per-user ACL'd — a weaker but not open fallback.
    pub fn load_or_create_secret() -> String {
        let path = secret_path();
        if let Ok(stored) = std::fs::read(&path) {
            if let Some(plain) = crate::win::unprotect(&stored) {
                if let Ok(text) = String::from_utf8(plain) {
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
            if let Ok(text) = String::from_utf8(stored) {
                let trimmed = text.trim();
                if !trimmed.is_empty() && trimmed.len() == 64 {
                    return trimmed.to_string();
                }
            }
        }

        let mut bytes = [0u8; 32];
        // A failure here would mean no OS entropy; a predictable password on
        // a loopback server is not an acceptable degradation.
        getrandom::fill(&mut bytes).expect("the OS random source is unavailable");
        let secret = encode_secret(&bytes);

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match crate::win::protect(secret.as_bytes()) {
            Some(sealed) => {
                let _ = std::fs::write(&path, sealed);
            }
            None => {
                let _ = std::fs::write(&path, secret.as_bytes());
            }
        }
        secret
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_the_documented_port() {
        assert_eq!(Config::default().port, 30179);
        assert_eq!(parse_config("{}").port, 30179);
    }

    #[test]
    fn config_round_trips() {
        let body = serde_json::to_string(&Config { port: 41000 }).unwrap();
        assert_eq!(parse_config(&body).port, 41000);
    }

    #[test]
    fn a_corrupt_config_falls_back_rather_than_failing() {
        assert_eq!(parse_config("not json").port, 30179);
        assert_eq!(parse_config(r#"{"port":"nope"}"#).port, 30179);
    }

    #[test]
    fn secrets_encode_to_64_hex_characters() {
        let secret = encode_secret(&[0xAB; 32]);
        assert_eq!(secret.len(), 64);
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(secret, "ab".repeat(32));
    }
}
