#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The shell is Windows-only. The host build exists so the pure-logic modules
// stay unit-testable on a Linux CI box, where the Tauri toolchain is absent.
#![cfg_attr(not(windows), allow(dead_code))]

mod auth;
mod config;
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
    use crate::{auth, commands, config, gpu, rootfs, server, status, update, wsl};
    use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::{
        AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    };
    use tauri_plugin_opener::OpenerExt;

    const WINDOW_LABEL: &str = "main";
    const WSL_DOCS: &str = "https://learn.microsoft.com/en-us/windows/wsl/install";
    const WSL_TROUBLESHOOTING: &str =
        "https://learn.microsoft.com/en-us/windows/wsl/troubleshooting";
    const INSTALLING: &str =
        "Installing the Cody runtime — this takes a few minutes the first time…";

    pub struct Shell {
        status: Mutex<Status>,
        port: AtomicU16,
        runtime: Mutex<update::InstalledRuntime>,
        gpu: Mutex<Option<gpu::Gpu>>,
        /// Bumped by every `start_setup`; a supervisor whose generation is
        /// stale retires rather than fighting the new one.
        generation: AtomicU64,
        busy: AtomicBool,
        bootstrap_url: Mutex<Option<Url>>,
        server: Arc<server::Server>,
        secret: String,
    }

    impl Shell {
        fn new(port: u16, secret: String) -> Arc<Self> {
            Arc::new(Self {
                status: Mutex::new(Status::default()),
                port: AtomicU16::new(port),
                runtime: Mutex::new(update::InstalledRuntime::default()),
                gpu: Mutex::new(None),
                generation: AtomicU64::new(0),
                busy: AtomicBool::new(false),
                bootstrap_url: Mutex::new(None),
                server: server::Server::new(),
                secret,
            })
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
            config::save(&config::Config { port });
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
        match url.scheme() {
            "tauri" | "about" => true,
            "http" | "https" => matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost")
            ),
            _ => false,
        }
    }

    pub fn run() {
        let stored = config::load();
        let shell = Shell::new(stored.port, config::load_or_create_secret());
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
            .manage(Arc::clone(&shell))
            .invoke_handler(tauri::generate_handler![
                commands::bootstrap_status,
                commands::bootstrap_retry,
                commands::desktop_info,
                commands::open_external,
                commands::runtime_update_check,
                commands::runtime_update_apply,
            ])
            .setup(move |app| {
                let handle = app.handle().clone();
                let opener = app.handle().clone();
                let main = WebviewWindowBuilder::new(
                    app,
                    WINDOW_LABEL,
                    WebviewUrl::App("index.html".into()),
                )
                .title("Cody")
                // The web app draws the titlebar; `shadow` is what gives an
                // undecorated window its Win11 rounded corners.
                .decorations(false)
                .shadow(true)
                .resizable(true)
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
                ) {
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
