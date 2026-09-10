#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The shell is Windows-only. The host build exists so the pure-logic modules
// stay unit-testable on a Linux CI box, where the Tauri toolchain is absent.
#![cfg_attr(not(windows), allow(dead_code))]

mod auth;
mod config;
mod desktop_status_icon;
mod gpu;
mod rootfs;
mod server;
mod status;
mod update;
mod win;
mod wsl;

#[cfg(windows)]
mod commands;

#[cfg(windows)]
pub use shell::*;

#[cfg(windows)]
mod shell {
    use crate::status::{Failure, FailureKind, Phase, Status};
    use crate::{
        auth, commands, config, desktop_status_icon, gpu, rootfs, server, status, update, wsl,
    };
    use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::{
        image::Image,
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        webview::PageLoadEvent,
        AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
        WindowEvent,
    };
    use tauri_plugin_opener::OpenerExt;

    const WINDOW_LABEL: &str = "main";
    const WSL_DOCS: &str = "https://learn.microsoft.com/en-us/windows/wsl/install";
    const WSL_TROUBLESHOOTING: &str =
        "https://learn.microsoft.com/en-us/windows/wsl/troubleshooting";
    const INSTALLING: &str =
        "Installing the Cody runtime — this takes a few minutes the first time…";
    // WebView2 otherwise reserves a classic document scrollbar gutter even
    // though Cody scrolls its own panels. Keep this shell-only: the browser
    // version should retain its normal scrollbar behavior.
    const DESKTOP_SCROLLBAR_STYLE: &str = r#"
(function () {
  const styleId = "cody-desktop-scrollbar-fix";
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    html,
    body {
      overflow: hidden !important;
      scrollbar-gutter: auto !important;
    }
    *,
    *::before,
    *::after {
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    *::-webkit-scrollbar {
      width: 0 !important;
      height: 0 !important;
      display: none !important;
      background: transparent !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})();
"#;

    pub struct Shell {
        status: Mutex<Status>,
        config: Mutex<config::Config>,
        port: AtomicU16,
        runtime: Mutex<update::InstalledRuntime>,
        gpu: Mutex<Option<gpu::Gpu>>,
        /// Bumped by every `start_setup`; a supervisor whose generation is
        /// stale retires rather than fighting the new one.
        generation: AtomicU64,
        busy: AtomicBool,
        exiting: AtomicBool,
        bootstrap_url: Mutex<Option<Url>>,
        server: Arc<server::Server>,
        secret: String,
        desktop_status: Mutex<commands::DesktopStatusUpdate>,
        desktop_state: Mutex<config::DesktopState>,
    }

    impl Shell {
        fn new(stored: config::Config, secret: String) -> Arc<Self> {
            let desktop_state = config::load_desktop_state();
            let unread_ids = desktop_state.unread_ids.clone();
            Arc::new(Self {
                status: Mutex::new(Status::default()),
                config: Mutex::new(stored.clone()),
                port: AtomicU16::new(stored.port),
                runtime: Mutex::new(update::InstalledRuntime::default()),
                gpu: Mutex::new(None),
                generation: AtomicU64::new(0),
                busy: AtomicBool::new(false),
                exiting: AtomicBool::new(false),
                bootstrap_url: Mutex::new(None),
                server: server::Server::new(),
                secret,
                desktop_status: Mutex::new(commands::DesktopStatusUpdate {
                    active_sessions: 0,
                    active_subagents: 0,
                    unread: unread_ids.len() as u32,
                    completed: false,
                    unread_ids,
                    completion_id: None,
                    completion_kind: None,
                }),
                desktop_state: Mutex::new(desktop_state),
            })
        }

        pub fn config(&self) -> config::Config {
            self.config.lock().unwrap().clone()
        }

        pub fn is_local_mode(&self) -> bool {
            self.config().mode == config::Mode::Local
        }

        pub fn request_exit(&self) {
            self.exiting.store(true, Ordering::SeqCst);
        }

        pub fn should_hide_on_close(&self) -> bool {
            self.config().close_to_tray && !self.exiting.load(Ordering::SeqCst)
        }

        pub fn update_config(&self, next: config::Config) {
            self.port.store(next.port, Ordering::SeqCst);
            *self.config.lock().unwrap() = next.clone();
            config::save(&next);
        }

        pub fn update_desktop_status(
            &self,
            app: &AppHandle,
            mut next: commands::DesktopStatusUpdate,
        ) {
            next.unread_ids = config::bounded_unique_ids(next.unread_ids, 100);
            next.unread = next.unread_ids.len() as u32;
            let config = self.config();
            let duplicate = {
                let mut state = self.desktop_state.lock().unwrap();
                let duplicate = next
                    .completion_id
                    .as_ref()
                    .is_some_and(|id| state.recent_completion_ids.iter().any(|known| known == id));
                if let Some(id) = next.completion_id.clone() {
                    state.recent_completion_ids = config::bounded_unique_ids(
                        state
                            .recent_completion_ids
                            .iter()
                            .cloned()
                            .chain(std::iter::once(id)),
                        200,
                    );
                }
                state.unread_ids = next.unread_ids.clone();
                let _ = config::save_desktop_state(&state);
                duplicate
            };
            *self.desktop_status.lock().unwrap() = next.clone();
            update_native_desktop_indicators(app, &next);
            let should_notify = next.completed
                && !duplicate
                && notification_scope_matches(config.sound_scope, next.completion_kind.as_deref());
            if should_notify && config.sound_enabled {
                play_completion_sound(config.sound_volume);
            }
            if next.completed
                && !duplicate
                && config.toast_enabled
                && notification_scope_matches(config.toast_scope, next.completion_kind.as_deref())
            {
                use tauri_plugin_notification::NotificationExt;
                let _ = app
                    .notification()
                    .builder()
                    .title("Cody")
                    .body(if next.unread == 1 {
                        "An agent run finished."
                    } else {
                        "Agent runs finished."
                    })
                    .show();
            }
        }

        pub fn mark_desktop_read(&self, app: &AppHandle) {
            {
                let mut state = self.desktop_state.lock().unwrap();
                state.unread_ids.clear();
                let _ = config::save_desktop_state(&state);
            }
            let status = {
                let mut status = self.desktop_status.lock().unwrap();
                status.unread = 0;
                status.unread_ids.clear();
                status.clone()
            };
            update_native_desktop_indicators(app, &status);
        }

        pub fn desktop_status_info(&self) -> commands::DesktopStatusInfo {
            let status = self.desktop_status.lock().unwrap().clone();
            commands::DesktopStatusInfo {
                active_sessions: status.active_sessions,
                active_subagents: status.active_subagents,
                unread: status.unread,
                unread_ids: status.unread_ids,
            }
        }

        pub fn test_desktop_sound(&self) {
            play_completion_sound(self.config().sound_volume);
        }

        pub fn status(&self) -> Status {
            self.status.lock().unwrap().clone()
        }

        pub fn port(&self) -> u16 {
            self.port.load(Ordering::SeqCst)
        }

        pub fn runtime_version(&self) -> Option<String> {
            self.runtime.lock().unwrap().version.clone()
        }

        pub fn installed_runtime(&self) -> update::InstalledRuntime {
            self.runtime.lock().unwrap().clone()
        }

        pub fn gpu(&self) -> Option<gpu::Gpu> {
            self.gpu.lock().unwrap().clone()
        }

        fn publish(&self, app: &AppHandle, next: Status) {
            *self.status.lock().unwrap() = next.clone();
            let _ = app.emit(status::EVENT, next);
        }
    }

    /// The bootstrap page reads a snapshot once through `bootstrap_status`
    /// and then follows the event stream, so a status change that lands
    /// before the listener attaches is never lost.
    fn window(app: &AppHandle) -> Option<WebviewWindow> {
        app.get_webview_window(WINDOW_LABEL)
    }

    fn notification_scope_matches(scope: config::NotificationScope, kind: Option<&str>) -> bool {
        matches!(
            (scope, kind.unwrap_or("session")),
            (config::NotificationScope::Both, _)
                | (config::NotificationScope::Session, "session")
                | (config::NotificationScope::Subagent, "subagent")
        )
    }

    fn desktop_status_overlay_icon(active: bool, unread: u32) -> Option<Image<'static>> {
        desktop_status_icon::status_overlay_rgba(active, unread).map(|rgba| {
            Image::new_owned(
                rgba,
                desktop_status_icon::STATUS_OVERLAY_SIZE,
                desktop_status_icon::STATUS_OVERLAY_SIZE,
            )
        })
    }

    fn desktop_status_tray_icon(
        app: &AppHandle,
        active: bool,
        unread: u32,
    ) -> Option<Image<'static>> {
        let base = app.default_window_icon()?;
        let rgba = desktop_status_icon::composite_status_rgba(
            base.rgba(),
            base.width(),
            base.height(),
            active,
            unread,
        )?;
        Some(Image::new_owned(rgba, base.width(), base.height()))
    }

    fn update_native_desktop_indicators(app: &AppHandle, status: &commands::DesktopStatusUpdate) {
        let active = status.active_sessions > 0 || status.active_subagents > 0;
        // A subagent can finish while its parent session is still running.
        // Keep the taskbar/tray state unambiguous: active work is green, and
        // the unread completion badge only appears once everything is idle.
        let visible_unread = if active { 0 } else { status.unread };
        let title = if visible_unread > 0 {
            format!("Cody ({})", visible_unread)
        } else {
            "Cody".to_string()
        };
        if let Some(window) = window(app) {
            let _ = window.set_title(&title);
            // Windows can retain a stale ITaskbarList3 overlay after the
            // state changes. Clear it first, then set the current overlay.
            // Updating the window icon alone does not reliably repaint an
            // existing taskbar button, while SetOverlayIcon is designed for
            // this exact taskbar status channel.
            let _ = window.set_overlay_icon(None);
            if let Some(icon) = desktop_status_overlay_icon(active, visible_unread) {
                let _ = window.set_overlay_icon(Some(icon));
            }
        }
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(desktop_status_tray_icon(app, active, visible_unread));
            let _ = tray.set_tooltip(Some(format!(
                "Cody · {} active sessions · {} active subagents · {} unread",
                status.active_sessions, status.active_subagents, status.unread
            )));
        }
    }

    fn completion_wav(volume: u8) -> Vec<u8> {
        const SAMPLE_RATE: u32 = 44_100;
        const DURATION_SECONDS: f32 = 0.36;
        let samples = (SAMPLE_RATE as f32 * DURATION_SECONDS) as usize;
        let mut pcm = Vec::with_capacity(samples * 2);
        for index in 0..samples {
            let time = index as f32 / SAMPLE_RATE as f32;
            let frequency = if time < 0.18 { 523.25 } else { 659.25 };
            let local = if time < 0.18 { time } else { time - 0.18 };
            let envelope = (local / 0.02).min(1.0) * ((DURATION_SECONDS - time) / 0.06).min(1.0);
            let amplitude = 9_000.0 * (volume as f32 / 100.0) * envelope.max(0.0);
            let sample = (amplitude * (std::f32::consts::TAU * frequency * time).sin()) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        let mut wav = Vec::with_capacity(44 + pcm.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(&pcm);
        wav
    }

    #[allow(unsafe_code)]
    fn play_completion_sound(volume: u8) {
        if volume == 0 {
            return;
        }
        std::thread::spawn(move || {
            use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_MEMORY, SND_NODEFAULT};
            let wav = completion_wav(volume);
            unsafe {
                let _ = PlaySoundW(
                    wav.as_ptr() as _,
                    std::ptr::null_mut(),
                    SND_MEMORY | SND_NODEFAULT,
                );
            }
        });
    }

    /// Status is published *before* the navigation, so the snapshot the
    /// reloaded page reads already carries the reason it is being shown.
    fn show_bootstrap(app: &AppHandle, shell: &Shell, next: Status) {
        shell.publish(app, next);
        let url = shell.bootstrap_url.lock().unwrap().clone();
        if let (Some(window), Some(url)) = (window(app), url) {
            let _ = window.navigate(url);
        }
    }

    fn failure(kind: FailureKind, title: &str, detail: &str) -> Failure {
        Failure {
            kind,
            title: title.to_string(),
            detail: detail.to_string(),
            command: None,
            docs: None,
            elevated: false,
            retryable: true,
        }
    }

    fn wsl_failure(problem: wsl::Problem, output: &str) -> Failure {
        let mut failure = match problem {
            wsl::Problem::NoBinary | wsl::Problem::FeatureDisabled => Failure {
                command: Some("wsl --install --no-distribution".into()),
                docs: Some(WSL_DOCS.into()),
                elevated: true,
                ..failure(
                    problem.kind(),
                    "Windows Subsystem for Linux isn't enabled",
                    "Cody runs its Linux runtime inside WSL2. Open Terminal or PowerShell as \
                     Administrator, run the command below, then restart Windows and start Cody \
                     again.",
                )
            },
            wsl::Problem::VirtualizationDisabled => Failure {
                docs: Some(WSL_TROUBLESHOOTING.into()),
                ..failure(
                    problem.kind(),
                    "Virtualization is turned off",
                    "WSL2 needs hardware virtualization. Enable Intel VT-x or AMD-V (sometimes \
                     listed as SVM) in your PC's UEFI/BIOS setup, then start Cody again. CPUs \
                     without SLAT cannot run WSL2 at all.",
                )
            },
            wsl::Problem::KernelOutdated => Failure {
                command: Some("wsl --update".into()),
                docs: Some(WSL_DOCS.into()),
                elevated: true,
                ..failure(
                    problem.kind(),
                    "WSL needs an update",
                    "The WSL2 kernel component is missing or out of date. Run the command below \
                     — an Administrator prompt may appear — then start Cody again.",
                )
            },
            wsl::Problem::NotSystemDrive => failure(
                problem.kind(),
                "Cody's runtime must live on your system drive",
                "WSL only runs distributions stored on the Windows system drive (usually C:). \
                 Cody installs its runtime under %LOCALAPPDATA%; if that folder has been \
                 redirected to another drive, move it back before retrying.",
            ),
            wsl::Problem::Unknown => Failure {
                docs: Some(WSL_TROUBLESHOOTING.into()),
                ..failure(
                    problem.kind(),
                    "WSL didn't answer as expected",
                    "Cody could not determine the state of WSL on this machine.",
                )
            },
        };
        let output = output.trim();
        if !output.is_empty() {
            failure.detail = format!("{}\n\n{output}", failure.detail);
        }
        failure
    }

    pub fn start_setup(app: AppHandle, shell: Arc<Shell>) {
        if shell.busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let generation = shell.generation.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            let outcome = setup(&app, &shell, generation);
            shell.busy.store(false, Ordering::SeqCst);
            if let Err(failed) = outcome {
                show_bootstrap(&app, &shell, Status::failed(failed));
            }
        });
    }

    fn setup(app: &AppHandle, shell: &Arc<Shell>, generation: u64) -> Result<(), Failure> {
        let stored = shell.config();
        if stored.mode == config::Mode::Remote {
            return setup_remote(app, shell, generation, &stored);
        }
        shell.publish(
            app,
            Status::working(Phase::CheckingWsl, "Checking Windows Subsystem for Linux…"),
        );
        // Cheap, and the answer only changes when hardware or drivers do.
        if shell.gpu().is_none() {
            *shell.gpu.lock().unwrap() = gpu::detect();
        }
        wsl::probe().map_err(|problem| wsl_failure(problem, ""))?;

        let manifest = update::fetch_manifest();

        // A shell update replaces this process, so it happens before any
        // multi-minute runtime work is started.
        if let Ok(manifest) = &manifest {
            if let Some(artifact) = update::newer_shell(manifest) {
                shell.publish(app, Status::working(Phase::Downloading, "Updating Cody…"));
                if let Err(message) = update::apply(artifact) {
                    // A failed self-update must never block the app.
                    eprintln!("cody: shell update skipped: {message}");
                }
            }
        }

        let installed =
            wsl::distro_exists().map_err(|e| wsl_failure(e.problem(), &e.to_string()))?;
        if !installed {
            let artifact = manifest
                .as_ref()
                .ok()
                .and_then(|m| m.runtime.clone())
                .ok_or_else(|| Failure {
                    docs: Some(WSL_DOCS.into()),
                    ..failure(
                        FailureKind::Download,
                        "Couldn't reach the Cody release manifest",
                        "The first run needs to download the Cody runtime. Check your internet \
                         connection and try again.",
                    )
                })?;

            let archive = rootfs::archive_path(&artifact);
            rootfs::download(&artifact, &archive, |received, total| {
                shell.publish(
                    app,
                    Status::measured(
                        Phase::Downloading,
                        "Downloading the Cody runtime…",
                        received,
                        total,
                    ),
                );
            })
            .map_err(|message| Failure {
                detail: message,
                ..failure(
                    FailureKind::Download,
                    "The runtime download didn't finish",
                    "",
                )
            })?;

            // The archive is measurable even though `wsl --import` reports
            // nothing, so the bar tracks bytes handed over — never a guess.
            shell.publish(app, Status::working(Phase::Importing, INSTALLING));
            rootfs::import(&archive, &artifact.markers(), |received, total| {
                shell.publish(
                    app,
                    Status::measured(Phase::Importing, INSTALLING, received, total),
                );
            })
            .map_err(|message| Failure {
                detail: message,
                ..failure(FailureKind::Import, "The runtime couldn't be installed", "")
            })?;

            // A fresh install is also what an update that lost its distro
            // leaves behind, so any backup nobody has unpacked belongs in
            // this one. Never fatal: the tar stays on disk, still unmarked.
            match rootfs::restore_pending_backup(|phase| {
                shell.publish(app, Status::working(Phase::Importing, phase));
            }) {
                Ok(Some(backup)) => eprintln!("cody: restored {}", backup.display()),
                Ok(None) => {}
                Err(message) => eprintln!("cody: earlier Cody data was not restored: {message}"),
            }
        }

        *shell.runtime.lock().unwrap() = wsl::read_installed_runtime();

        shell.publish(
            app,
            Status::working(Phase::StartingServer, "Starting Cody…"),
        );
        let port = config::pick_port(shell.port());
        if port != shell.port() {
            shell.port.store(port, Ordering::SeqCst);
            let mut next = shell.config();
            next.port = port;
            shell.update_config(next);
        }
        shell
            .server
            .start(port, &shell.secret)
            .map_err(|e| Failure {
                detail: e.to_string(),
                ..failure(FailureKind::ServerStart, "Cody's runtime didn't start", "")
            })?;
        shell.server.wait_healthy(port).map_err(|message| Failure {
            detail: message,
            ..failure(
                FailureKind::ServerStart,
                "Cody started but didn't answer",
                "",
            )
        })?;

        shell.publish(app, Status::working(Phase::SigningIn, "Signing in…"));
        if let Some(main) = window(app) {
            match auth::sign_in(port, &shell.secret).and_then(|token| auth::inject(&main, &token)) {
                Ok(()) => {}
                // The fallback is Cody's own first-run/login screen, which is
                // reachable and safe; it costs a step, not access.
                Err(message) => eprintln!("cody: silent sign-in unavailable: {message}"),
            }
            let url = Url::parse(&server::app_url(port)).map_err(|e| Failure {
                detail: e.to_string(),
                ..failure(FailureKind::ServerStart, "Cody's address was rejected", "")
            })?;
            main.navigate(url).map_err(|e| Failure {
                detail: e.to_string(),
                ..failure(FailureKind::ServerStart, "Cody's window couldn't load", "")
            })?;
        }

        shell.publish(app, Status::working(Phase::Ready, "Ready"));
        supervise(app.clone(), Arc::clone(shell), port, generation);
        Ok(())
    }

    fn setup_remote(
        app: &AppHandle,
        shell: &Arc<Shell>,
        _generation: u64,
        stored: &config::Config,
    ) -> Result<(), Failure> {
        shell.publish(
            app,
            Status::working(Phase::CheckingRemote, "Connecting to remote Cody…"),
        );
        if !config::is_allowed_app_url(&stored.remote_url) {
            return Err(failure(
                FailureKind::RemoteUrlInvalid,
                "Remote Cody URL is not allowed",
                "Use the HTTPS origin configured for this desktop build. Local development URLs must use http://localhost:<port> or http://127.0.0.1:<port>.",
            ));
        }
        server::wait_remote_healthy(&stored.remote_url).map_err(|detail| Failure {
            detail,
            ..failure(
                FailureKind::RemoteConnection,
                "Remote Cody could not be reached",
                "Check that Cody is running and that this machine trusts its TLS certificate.",
            )
        })?;
        let url = Url::parse(&stored.remote_url).map_err(|e| Failure {
            detail: e.to_string(),
            ..failure(
                FailureKind::RemoteUrlInvalid,
                "Remote Cody URL is invalid",
                "",
            )
        })?;
        if let Some(main) = window(app) {
            main.navigate(url).map_err(|e| Failure {
                detail: e.to_string(),
                ..failure(
                    FailureKind::RemoteConnection,
                    "Cody's window couldn't load",
                    "",
                )
            })?;
        }
        shell.publish(app, Status::working(Phase::Ready, "Connected"));
        Ok(())
    }

    /// A server that dies takes the window back to the bootstrap page. Three
    /// automatic restarts, then a human decides.
    fn supervise(app: AppHandle, shell: Arc<Shell>, port: u16, generation: u64) {
        std::thread::spawn(move || {
            let mut attempt = 0u32;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if shell.server.is_shutting_down()
                    || shell.generation.load(Ordering::SeqCst) != generation
                {
                    return;
                }
                let Some(code) = shell.server.exited() else {
                    attempt = 0;
                    continue;
                };
                let Some(delay) = server::Server::restart_backoff(attempt) else {
                    show_bootstrap(
                        &app,
                        &shell,
                        Status::failed(Failure {
                            detail: format!("The runtime exited repeatedly (last code {code})."),
                            ..failure(
                                FailureKind::ServerStart,
                                "Cody's runtime keeps stopping",
                                "",
                            )
                        }),
                    );
                    return;
                };
                attempt += 1;
                show_bootstrap(
                    &app,
                    &shell,
                    Status::working(Phase::StartingServer, "Restarting Cody…"),
                );
                std::thread::sleep(delay);
                if shell.server.start(port, &shell.secret).is_err() {
                    continue;
                }
                if shell.server.wait_healthy(port).is_ok() {
                    if let Some(main) = window(&app) {
                        if let Ok(url) = Url::parse(&server::app_url(port)) {
                            let _ = main.navigate(url);
                        }
                    }
                    shell.publish(&app, Status::working(Phase::Ready, "Ready"));
                }
            }
        });
    }

    pub fn start_runtime_update(app: AppHandle, shell: Arc<Shell>) -> Result<(), String> {
        if !shell.is_local_mode() {
            return Err("Runtime updates are only available in local WSL mode.".into());
        }
        if shell.busy.swap(true, Ordering::SeqCst) {
            return Err("Cody is already busy.".into());
        }
        std::thread::spawn(move || {
            let result = run_runtime_update(&app, &shell);
            shell.busy.store(false, Ordering::SeqCst);
            match result {
                Ok(()) => start_setup(app, shell),
                Err(message) => {
                    show_bootstrap(
                        &app,
                        &shell,
                        Status::failed(Failure {
                            detail: message,
                            ..failure(FailureKind::Import, "The runtime update didn't finish", "")
                        }),
                    );
                }
            }
        });
        Ok(())
    }

    fn run_runtime_update(app: &AppHandle, shell: &Arc<Shell>) -> Result<(), String> {
        let artifact = update::fetch_manifest()?
            .runtime
            .ok_or_else(|| "The release manifest lists no runtime.".to_string())?;

        show_bootstrap(
            app,
            shell,
            Status::working(Phase::Downloading, "Preparing the runtime update…"),
        );
        let archive = rootfs::archive_path(&artifact);
        rootfs::download(&artifact, &archive, |received, total| {
            shell.publish(
                app,
                Status::measured(
                    Phase::Downloading,
                    "Downloading the new Cody runtime…",
                    received,
                    total,
                ),
            );
        })?;

        shell.server.stop();
        rootfs::replace_runtime(&archive, &artifact, |phase| {
            shell.publish(app, Status::working(Phase::Importing, phase));
        })?;
        *shell.runtime.lock().unwrap() = artifact.markers();
        Ok(())
    }

    /// Non-app origins are handed to the system browser and cancelled in the
    /// webview. Returning `false` without opening it would make the link
    /// silently die.
    fn is_internal(url: &Url) -> bool {
        if config::is_internal_app_url(url.as_str()) {
            return true;
        }
        match url.scheme() {
            "tauri" | "about" => true,
            "http" | "https" => config::is_allowed_app_url(url.as_str()),
            _ => false,
        }
    }

    pub fn run() {
        let stored = config::load();
        let shell = Shell::new(stored, config::load_or_create_secret());
        let teardown = Arc::clone(&shell);

        tauri::Builder::default()
            // Must be registered before every other plugin.
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_notification::init())
            .manage(Arc::clone(&shell))
            .invoke_handler(tauri::generate_handler![
                commands::bootstrap_status,
                commands::bootstrap_retry,
                commands::desktop_info,
                commands::open_external,
                commands::runtime_update_check,
                commands::runtime_update_apply,
                commands::desktop_config,
                commands::desktop_config_save,
                commands::desktop_status,
                commands::desktop_status_update,
                commands::desktop_mark_read,
                commands::desktop_test_sound,
            ])
            .setup(move |app| {
                let show = MenuItem::with_id(app, "show", "Show Cody", true, None::<&str>)?;
                let mark_read = MenuItem::with_id(
                    app,
                    "mark-read",
                    "Mark notifications read",
                    true,
                    None::<&str>,
                )?;
                let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Cody", true, None::<&str>)?;
                let tray_menu = Menu::with_items(app, &[&show, &mark_read, &settings, &quit])?;
                let mut tray = TrayIconBuilder::with_id("main")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Cody")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "mark-read" => {
                            let shell = app.state::<Arc<Shell>>();
                            shell.mark_desktop_read(app);
                        }
                        "settings" => {
                            let _ = app.emit("cody://open-settings", "desktop");
                            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.state::<Arc<Shell>>().request_exit();
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
                let handle = app.handle().clone();
                let opener = app.handle().clone();
                let close_shell = Arc::clone(&shell);
                let main = WebviewWindowBuilder::new(
                    app,
                    WINDOW_LABEL,
                    WebviewUrl::App("index.html".into()),
                )
                .title("Cody")
                // The web app draws the titlebar. Keep the shell fully
                // frameless: Tauri's undecorated resize overlay paints a
                // system-colored strip over the right edge of the WebView.
                // The custom min/max/close controls remain available, while
                // edge-drag resizing is intentionally disabled until it can
                // be implemented without covering the WebView.
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .initialization_script(DESKTOP_SCROLLBAR_STYLE)
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        let _ = window.eval(DESKTOP_SCROLLBAR_STYLE);
                    }
                })
                .minimizable(true)
                .maximizable(true)
                .closable(true)
                .center()
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .zoom_hotkeys_enabled(false)
                .on_navigation(move |url| {
                    let internal = is_internal(url);
                    if !internal && matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    internal
                })
                .build()?;

                let initial_desktop_status = shell.desktop_status.lock().unwrap().clone();
                update_native_desktop_indicators(app.handle(), &initial_desktop_status);
                let close_window = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if close_shell.should_hide_on_close() {
                            api.prevent_close();
                            let _ = close_window.hide();
                        }
                    }
                });

                // Captured before the first navigation so the shell can
                // return here without recomputing the app scheme; the
                // literal is the Windows form wry serves bundled assets on,
                // kept only as a fallback if the webview has no URL yet.
                *shell.bootstrap_url.lock().unwrap() = main
                    .url()
                    .ok()
                    .filter(is_internal)
                    .or_else(|| Url::parse("http://tauri.localhost/index.html").ok());

                start_setup(handle, Arc::clone(&shell));
                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("failed to start the Cody shell")
            .run(move |_app, event| {
                if matches!(
                    event,
                    tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
                ) && teardown.is_local_mode()
                {
                    teardown.server.shutdown();
                }
            });
    }
}

#[cfg(windows)]
fn main() {
    shell::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The Cody desktop shell runs on Windows only.");
}
