//! The IPC surface. Window chrome is deliberately absent: the web app calls
//! the core window API directly through `window.__TAURI__`, so the only
//! commands here are the ones with no core equivalent.

use crate::gpu::Gpu;
use crate::status::Status;
use crate::update;
use crate::Shell;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub shell_version: &'static str,
    pub runtime_version: Option<String>,
    pub port: u16,
    pub gpu: Option<Gpu>,
    pub manifest_url: &'static str,
    pub mode: crate::config::Mode,
    pub remote_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdate {
    pub current: Option<String>,
    pub available: Option<String>,
    pub update_available: bool,
}

#[tauri::command]
pub fn bootstrap_status(shell: State<'_, Arc<Shell>>) -> Status {
    shell.status()
}

#[tauri::command]
pub fn bootstrap_retry(app: AppHandle, shell: State<'_, Arc<Shell>>) {
    crate::start_setup(app, shell.inner().clone());
}

#[tauri::command]
pub fn desktop_info(shell: State<'_, Arc<Shell>>) -> DesktopInfo {
    let config = shell.config();
    DesktopInfo {
        shell_version: update::SHELL_VERSION,
        runtime_version: shell.runtime_version(),
        port: shell.port(),
        gpu: shell.gpu(),
        manifest_url: update::MANIFEST_URL,
        mode: config.mode,
        remote_url: config.remote_url,
    }
}

#[tauri::command]
pub fn desktop_config(shell: State<'_, Arc<Shell>>) -> crate::config::Config {
    shell.config()
}

#[tauri::command]
pub fn desktop_config_save(
    shell: State<'_, Arc<Shell>>,
    next: crate::config::Config,
) -> Result<crate::config::Config, String> {
    crate::config::validate_config(&next)?;
    crate::config::set_start_on_login(next.start_on_login)?;
    shell.update_config(next.clone());
    Ok(next)
}

/// Status commands are intentionally metadata-only. The web UI sends counts,
/// never transcript text or credentials, so a tray/toast integration cannot
/// accidentally leak the conversation into native logs.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatusUpdate {
    pub active_sessions: u32,
    pub active_subagents: u32,
    pub unread: u32,
    pub completed: bool,
    #[serde(default)]
    pub unread_ids: Vec<String>,
    #[serde(default)]
    pub completion_id: Option<String>,
    #[serde(default)]
    pub completion_kind: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatusInfo {
    pub active_sessions: u32,
    pub active_subagents: u32,
    pub unread: u32,
    pub unread_ids: Vec<String>,
}

#[tauri::command]
pub fn desktop_status_update(
    app: AppHandle,
    shell: State<'_, Arc<Shell>>,
    update: DesktopStatusUpdate,
) -> Result<(), String> {
    shell.update_desktop_status(&app, update);
    Ok(())
}

#[tauri::command]
pub fn desktop_status(shell: State<'_, Arc<Shell>>) -> DesktopStatusInfo {
    shell.desktop_status_info()
}

#[tauri::command]
pub fn desktop_test_sound(shell: State<'_, Arc<Shell>>) -> Result<(), String> {
    shell.test_desktop_sound();
    Ok(())
}

#[tauri::command]
pub fn desktop_mark_read(app: AppHandle, shell: State<'_, Arc<Shell>>) -> Result<(), String> {
    shell.mark_desktop_read(&app);
    Ok(())
}

/// The webview never navigates off the app origin; anything else the UI wants
/// opened goes to the user's default browser.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Not a valid URL.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("Only web links can be opened.".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn runtime_update_check(shell: State<'_, Arc<Shell>>) -> Result<RuntimeUpdate, String> {
    let installed = shell.installed_runtime();
    // Network work never runs on the main thread: a stalled release check
    // would freeze the window.
    let manifest = tauri::async_runtime::spawn_blocking(update::fetch_manifest)
        .await
        .map_err(|e| e.to_string())??;
    let update_available = update::newer_runtime(&manifest, &installed).is_some();
    let available = manifest.runtime.map(|artifact| artifact.version);
    Ok(RuntimeUpdate {
        current: installed.version,
        available,
        update_available,
    })
}

/// Returns as soon as the replacement starts; progress arrives on the status
/// event, because the export/import round trip runs for minutes.
#[tauri::command]
pub fn runtime_update_apply(app: AppHandle, shell: State<'_, Arc<Shell>>) -> Result<(), String> {
    crate::start_runtime_update(app, shell.inner().clone())
}
