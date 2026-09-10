//! Shell-owned state: install paths, the persisted port, and the per-install
//! server secret. Nothing here belongs to the runtime — everything the *app*
//! keeps lives in `/data` inside the distro.

use serde::{Deserialize, Serialize};
use url::Url;

/// Persisted in `%APPDATA%\Cody\config.json`; a collision moves it.
pub const DEFAULT_PORT: u16 = 30179;
/// Set by build.rs from the explicit environment override or an ignored
/// desktop/.env file. It is intentionally absent from source-controlled code.
pub const CONFIGURED_REMOTE_URL: Option<&str> = option_env!("CODY_DESKTOP_REMOTE_URL");

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Remote,
}

impl Default for Mode {
    fn default() -> Self {
        // A build with no configured origin is local-only. When a developer or
        // release build explicitly supplies an origin, a fresh config starts
        // there while users can still switch back to Local in the bootstrap UI.
        if CONFIGURED_REMOTE_URL.is_some() {
            Self::Remote
        } else {
            Self::Local
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationScope {
    Session,
    Subagent,
    #[default]
    Both,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default = "default_remote_url")]
    pub remote_url: String,
    #[serde(default)]
    pub close_to_tray: bool,
    #[serde(default)]
    pub start_on_login: bool,
    #[serde(default = "default_sound_enabled")]
    pub sound_enabled: bool,
    #[serde(default = "default_sound_volume")]
    pub sound_volume: u8,
    #[serde(default)]
    pub sound_scope: NotificationScope,
    #[serde(default = "default_toast_enabled")]
    pub toast_enabled: bool,
    #[serde(default)]
    pub toast_scope: NotificationScope,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn default_remote_url() -> String {
    CONFIGURED_REMOTE_URL.unwrap_or_default().to_string()
}

fn default_sound_enabled() -> bool {
    true
}

fn default_sound_volume() -> u8 {
    70
}

fn default_toast_enabled() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            mode: Mode::default(),
            remote_url: default_remote_url(),
            close_to_tray: false,
            start_on_login: false,
            sound_enabled: default_sound_enabled(),
            sound_volume: default_sound_volume(),
            sound_scope: NotificationScope::default(),
            toast_enabled: default_toast_enabled(),
            toast_scope: NotificationScope::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    #[serde(default)]
    pub unread_ids: Vec<String>,
    #[serde(default)]
    pub recent_completion_ids: Vec<String>,
}

pub fn bounded_unique_ids<I>(ids: I, limit: usize) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut result = Vec::new();
    for id in ids {
        if id.is_empty() || result.iter().any(|existing| existing == &id) {
            continue;
        }
        result.push(id);
        if result.len() > limit {
            result.remove(0);
        }
    }
    result
}

pub fn parse_config(body: &str) -> Config {
    let value = match serde_json::from_str::<serde_json::Value>(body) {
        Ok(value) => value,
        Err(_) => return Config::default(),
    };
    let mut config = serde_json::from_value::<Config>(value.clone()).unwrap_or_default();
    // The first shell version persisted only `port`. Treat that shape as a
    // local installation instead of silently switching an existing user to a
    // configured remote origin on upgrade.
    if value.get("mode").is_none() && value.get("port").is_some() {
        config.mode = Mode::Local;
    }
    config
}

/// Return true only for a well-formed HTTPS URL with the restrictions shared
/// by build-time capability generation and runtime navigation.
fn valid_remote_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.query().is_none()
        && url.port().is_none_or(|port| port == 443)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    valid_remote_url(left)
        && valid_remote_url(right)
        && left.origin().ascii_serialization() == right.origin().ascii_serialization()
}

/// The only externally configured origins the desktop WebView may display.
/// Local development keeps the two explicit loopback hosts. Remote navigation
/// is confined to the exact HTTPS origin baked into this build; userinfo,
/// queries, fragments, and arbitrary ports are rejected.
pub fn is_allowed_app_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let local = matches!(url.scheme(), "http")
        && matches!(host, "localhost" | "127.0.0.1")
        && url.port().is_some();
    let remote = CONFIGURED_REMOTE_URL
        .and_then(|configured| Url::parse(configured).ok())
        .is_some_and(|configured| same_origin(&url, &configured));
    local || remote
}

/// Tauri serves bundled assets from this fixed HTTP origin on Windows. It is
/// an internal WebView origin, not a remote Cody URL, so it is handled
/// separately from the user-configurable navigation policy above.
pub fn is_internal_app_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

pub fn validate_config(config: &Config) -> Result<(), String> {
    if config.mode == Mode::Remote && !is_allowed_app_url(&config.remote_url) {
        return Err(
            "Remote Cody URL must match the configured HTTPS origin and use no credentials, query, fragment, or arbitrary port.".into(),
        );
    }
    if config.mode == Mode::Local && !(1..=65535).contains(&config.port) {
        return Err("The local Cody port is invalid.".into());
    }
    if config.sound_volume > 100 {
        return Err("The desktop sound volume must be between 0 and 100.".into());
    }
    Ok(())
}

#[cfg(windows)]
#[allow(unsafe_code)]
pub fn set_start_on_login(enabled: bool) -> Result<(), String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
    };

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE_NAME: &str = "Cody";
    let wide = |value: &str| {
        value
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let key = wide(RUN_KEY);
    let value_name = wide(VALUE_NAME);
    let result = if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let command = wide(&format!("\"{}\"", executable.display()));
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value_name.as_ptr(),
                REG_SZ,
                command.as_ptr() as *const c_void,
                (command.len() * std::mem::size_of::<u16>()) as u32,
            )
        }
    } else {
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value_name.as_ptr()) }
    };

    if result != ERROR_SUCCESS && (enabled || result != ERROR_FILE_NOT_FOUND) {
        return Err(format!(
            "Windows startup preference failed (code {result})."
        ));
    }
    Ok(())
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

    fn desktop_state_path() -> PathBuf {
        app_dir().join("desktop-state.json")
    }

    pub fn load_desktop_state() -> DesktopState {
        let mut state = std::fs::read_to_string(desktop_state_path())
            .ok()
            .and_then(|body| serde_json::from_str::<DesktopState>(&body).ok())
            .unwrap_or_default();
        state.unread_ids = bounded_unique_ids(state.unread_ids, 100);
        state.recent_completion_ids = bounded_unique_ids(state.recent_completion_ids, 200);
        state
    }

    pub fn save_desktop_state(state: &DesktopState) -> Result<(), String> {
        let path = desktop_state_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let normalized = DesktopState {
            unread_ids: bounded_unique_ids(state.unread_ids.clone(), 100),
            recent_completion_ids: bounded_unique_ids(state.recent_completion_ids.clone(), 200),
        };
        let body = serde_json::to_string_pretty(&normalized).map_err(|error| error.to_string())?;
        std::fs::write(path, body).map_err(|error| error.to_string())
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
    fn config_defaults_to_the_documented_port_and_safe_mode() {
        assert_eq!(Config::default().port, 30179);
        assert_eq!(parse_config("{}").port, 30179);
        assert_eq!(Config::default().mode, Mode::default());
        assert_eq!(
            Config::default().remote_url,
            CONFIGURED_REMOTE_URL.unwrap_or_default()
        );
        assert!(Config::default().sound_enabled);
        assert_eq!(Config::default().sound_volume, 70);
        assert_eq!(Config::default().sound_scope, NotificationScope::Both);
        assert!(Config::default().toast_enabled);
    }

    #[test]
    fn config_round_trips() {
        let expected = Config {
            port: 41000,
            mode: Mode::Local,
            ..Config::default()
        };
        let body = serde_json::to_string(&expected).unwrap();
        let parsed = parse_config(&body);
        assert_eq!(parsed.port, 41000);
        assert_eq!(parsed.mode, Mode::Local);
        assert_eq!(parsed.sound_scope, NotificationScope::Both);
    }

    #[test]
    fn a_corrupt_config_falls_back_rather_than_failing() {
        assert_eq!(parse_config("not json").port, 30179);
        assert_eq!(parse_config(r#"{"port":"nope"}"#).port, 30179);
    }

    #[test]
    fn legacy_port_only_config_stays_local() {
        assert_eq!(parse_config(r#"{"port":30179}"#).mode, Mode::Local);
    }

    #[test]
    fn app_url_policy_keeps_remote_navigation_exact() {
        assert!(is_allowed_app_url("http://localhost:30179/"));
        assert!(is_allowed_app_url("http://127.0.0.1:30179/"));
        assert!(!is_allowed_app_url("http://localhost/"));
        assert!(!is_allowed_app_url("https://example.invalid/"));
        assert!(!is_allowed_app_url("https://user:pass@example.invalid/"));
        assert!(!is_allowed_app_url("https://example.invalid:8443/"));
        assert!(!is_allowed_app_url("https://example.invalid/#fragment"));
        assert!(!is_allowed_app_url("https://example.invalid/?query=1"));

        if let Some(configured) = CONFIGURED_REMOTE_URL {
            assert!(is_allowed_app_url(configured));
            let origin = Url::parse(configured)
                .unwrap()
                .origin()
                .ascii_serialization();
            assert!(is_allowed_app_url(&format!("{origin}/path")));
        }
    }

    #[test]
    fn internal_tauri_origin_is_not_a_remote_origin() {
        assert!(is_internal_app_url("http://tauri.localhost/"));
        assert!(is_internal_app_url("http://tauri.localhost/index.html"));
        assert!(!is_internal_app_url("https://tauri.localhost/"));
        assert!(!is_internal_app_url("http://tauri.localhost:30179/"));
        assert!(!is_internal_app_url("http://tauri.localhost.attacker/"));
        assert!(!is_internal_app_url("http://user:pass@tauri.localhost/"));
        assert!(!is_internal_app_url("http://tauri.localhost/#fragment"));
    }

    #[test]
    fn remote_config_requires_the_build_configured_origin() {
        let mut config = Config {
            mode: Mode::Remote,
            ..Config::default()
        };
        if CONFIGURED_REMOTE_URL.is_some() {
            assert!(validate_config(&config).is_ok());
        } else {
            assert!(validate_config(&config).is_err());
        }
        config.remote_url = "https://example.invalid".into();
        config.mode = Mode::Remote;
        assert!(validate_config(&config).is_err());
        config.mode = Mode::Local;
        assert!(validate_config(&config).is_ok());
        config.sound_volume = 101;
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn status_ids_are_unique_and_bounded() {
        let ids = bounded_unique_ids(["a", "b", "a", "c"].into_iter().map(str::to_string), 2);
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[test]
    fn secrets_encode_to_64_hex_characters() {
        let secret = encode_secret(&[0xAB; 32]);
        assert_eq!(secret.len(), 64);
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(secret, "ab".repeat(32));
    }
}
