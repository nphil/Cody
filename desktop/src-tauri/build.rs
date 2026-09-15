use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const REMOTE_ENV_KEY: &str = "CODY_DESKTOP_REMOTE_URL";
const REMOTE_CAPABILITY_FILE: &str = "capabilities/remote-server.json";

const APP_PERMISSIONS: &[&str] = &[
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-is-maximized",
    "core:window:allow-close",
    "allow-desktop-info",
    "allow-desktop-config",
    "allow-desktop-config-save",
    "allow-open-external",
    "allow-runtime-update-check",
    "allow-runtime-update-apply",
    "allow-desktop-status",
    "allow-desktop-status-update",
    "allow-desktop-mark-read",
    "allow-desktop-test-sound",
];

/// Return the value for one key in a dotenv-like file. The nested Option
/// distinguishes "file has no key" from "file explicitly sets an empty key".
fn env_file_value(path: &Path) -> Option<Option<String>> {
    let body = fs::read_to_string(path).ok()?;
    for line in body.lines() {
        let mut line = line.trim();
        if let Some(rest) = line.strip_prefix("export ") {
            line = rest.trim_start();
        }
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != REMOTE_ENV_KEY {
            continue;
        }
        let mut value = raw_value.trim().to_string();
        if ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
            && value.len() >= 2
        {
            value = value[1..value.len() - 1].to_string();
        } else if let Some(comment) = value.find(" #") {
            value.truncate(comment);
            value = value.trim_end().to_string();
        }
        return Some(Some(value));
    }
    Some(None)
}

/// Process environment wins over .env.local, which wins over .env. A present
/// empty process value intentionally disables lower-precedence env files.
fn configured_remote_url(desktop_dir: &Path) -> Option<String> {
    if env::var_os(REMOTE_ENV_KEY).is_some() {
        return Some(
            env::var_os(REMOTE_ENV_KEY)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
    }
    for name in [".env.local", ".env"] {
        if let Some(Some(value)) = env_file_value(&desktop_dir.join(name)) {
            return Some(value);
        }
    }
    None
}

/// Validate the build-time remote URL and return its exact origin. Paths are
/// allowed for deployments mounted below a path, but the capability is still
/// scoped to the origin and its paths, never to another host.
fn exact_remote_origin(raw: &str) -> Option<(String, String)> {
    let value = raw.trim();
    if value.is_empty() || value.chars().any(|character| character.is_control()) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return None;
    }
    Some((value.to_string(), url.origin().ascii_serialization()))
}

fn write_remote_capability(manifest_dir: &Path, origin: Option<&str>) {
    let mut capability = serde_json::json!({
        "$schema": "../gen/schemas/windows-schema.json",
        "identifier": "cody-remote-server",
        "description": "IPC granted to the one configured Cody HTTPS origin; local loopback access is declared separately.",
        "windows": ["main"],
        "local": false,
        "permissions": APP_PERMISSIONS,
    });
    if let Some(origin) = origin {
        capability["remote"] = serde_json::json!({ "urls": [format!("{origin}/*")] });
    }
    let path = manifest_dir.join(REMOTE_CAPABILITY_FILE);
    fs::write(
        path,
        serde_json::to_vec_pretty(&capability).expect("remote capability is serializable"),
    )
    .expect("remote capability is writable");
}

fn configure_remote_origin(manifest_dir: &Path) {
    let desktop_dir = manifest_dir
        .parent()
        .expect("src-tauri must have a desktop parent directory");
    println!("cargo:rerun-if-env-changed={REMOTE_ENV_KEY}");
    for name in [".env.local", ".env"] {
        println!(
            "cargo:rerun-if-changed={}",
            desktop_dir.join(name).display()
        );
    }

    let configured = configured_remote_url(desktop_dir);
    let remote = match configured.as_deref() {
        None => None,
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(exact_remote_origin(value).unwrap_or_else(|| {
            panic!(
                "{REMOTE_ENV_KEY} must be a valid HTTPS URL on the default port without credentials, query, or fragment"
            )
        })),
    };
    if let Some((value, origin)) = remote {
        // The value is consumed by config.rs through option_env!, so direct
        // cargo builds use the same compile-time configuration as npm builds.
        println!("cargo:rustc-env={REMOTE_ENV_KEY}={value}");
        write_remote_capability(manifest_dir, Some(&origin));
    } else {
        // Keep a stale ignored capability from widening a later local-only
        // build. The file contains no remote URL when no origin is configured.
        write_remote_capability(manifest_dir, None);
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    configure_remote_origin(&manifest_dir);

    // The bundle's version comes from tauri.conf.json, the binary's from
    // Cargo.toml, and the updater compares the manifest against the binary's.
    // Let them drift and the shipped installer reports a version nobody
    // published, so every update check says "newer" forever. Both files are
    // committed in step, so this only fires on genuine divergence — which in
    // practice means a release pipeline that patched one and not the other.
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let config = fs::read_to_string(manifest_dir.join("tauri.conf.json"))
        .expect("tauri.conf.json is unreadable");
    let config: serde_json::Value =
        serde_json::from_str(&config).expect("tauri.conf.json is not valid JSON");
    // No `version` key at all is legal: Tauri then takes the crate's, which
    // is the very thing being asserted here.
    if let Some(bundled) = config["version"].as_str() {
        let crate_version = env!("CARGO_PKG_VERSION");
        assert_eq!(
            bundled, crate_version,
            "version mismatch: tauri.conf.json says {bundled}, Cargo.toml says {crate_version}. \
             Both must move together, or the shell reports a version it was not built as."
        );
    }

    // Tauri's codegen only has meaning for the Windows artifact. Skipping it
    // for other targets is what lets the host build (pure-logic unit tests)
    // compile without a Tauri toolchain present.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    // Declaring the app's commands is what generates their `allow-*`
    // permissions; without them the remote origin cannot reach the IPC
    // surface at all, because Tauri gates every command invoked from a
    // non-local origin behind the ACL.
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "bootstrap_status",
            "bootstrap_retry",
            "desktop_info",
            "open_external",
            "runtime_update_check",
            "runtime_update_apply",
            "desktop_config",
            "desktop_config_save",
            "desktop_status",
            "desktop_status_update",
            "desktop_mark_read",
            "desktop_test_sound",
        ]));
    tauri_build::try_build(attributes).expect("tauri-build failed");
}
