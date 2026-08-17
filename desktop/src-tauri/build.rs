fn main() {
    // The bundle's version comes from tauri.conf.json, the binary's from
    // Cargo.toml, and the updater compares the manifest against the binary's.
    // Let them drift and the shipped installer reports a version nobody
    // published, so every update check says "newer" forever. Both files are
    // committed in step, so this only fires on genuine divergence — which in
    // practice means a release pipeline that patched one and not the other.
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let config = std::fs::read_to_string("tauri.conf.json").expect("tauri.conf.json is unreadable");
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
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
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
        ]));
    tauri_build::try_build(attributes).expect("tauri-build failed");
}
