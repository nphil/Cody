//! The Cody server child inside the `cody` distro: env block, launch, health,
//! restart, teardown.

/// `docker export` strips the image's `ENV`, so the shell owns the whole env
/// block and mirrors the Dockerfile. Desktop-only additions are appended
/// after the container-parity values.
pub fn env_block(
    port: u16,
    password: &str,
    host_gateway: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("HOME", "/data/home".to_string()),
        ("PI_CODING_AGENT_DIR", "/data/agent".to_string()),
        ("CODY_HARNESS", "omp".to_string()),
        ("CODY_CHROMIUM_BIN", "/usr/bin/chromium".to_string()),
        ("PORT", port.to_string()),
        ("NODE_ENV", "production".to_string()),
        ("TERM", "xterm-256color".to_string()),
        // Arms the existing env-managed `cody` admin so the shell can convert
        // it into an ordinary cookie session. Never leaves this machine.
        ("CODY_PASSWORD", password.to_string()),
        ("CODY_REQUIRE_ACCOUNTS", "1".to_string()),
        ("CODY_DESKTOP", "1".to_string()),
        // The entrypoint defaults to 0.0.0.0 for containers; on desktop the
        // loopback bind is the mode-agnostic safe choice (docs/windows.md).
        ("CODY_BIND_HOST", "127.0.0.1".to_string()),
    ];
    if let Some(gateway) = host_gateway {
        env.push(("CODY_HOST_GATEWAY", gateway.to_string()));
    }
    env
}

/// The entrypoint baked into the rootfs, identical to the container's.
pub const ENTRYPOINT: &str = "/usr/local/bin/cody-entrypoint";

pub const HEALTH_PATH: &str = "/api/accounts/state";

pub fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{HEALTH_PATH}")
}

/// The WebView is pointed at `localhost`; the health probe uses the literal
/// loopback address so a broken hosts file cannot mask a healthy server.
pub fn app_url(port: u16) -> String {
    format!("http://localhost:{port}/")
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::wsl;
    use std::io;
    use std::process::Child;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);
    const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
    const MAX_RESTARTS: u32 = 3;

    #[derive(Default)]
    pub struct Server {
        child: Mutex<Option<Child>>,
        shutting_down: AtomicBool,
    }

    impl Server {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        /// Clearing orphans first is the only reliable defence: killing
        /// `wsl.exe` on the Windows side does not reliably kill the Linux
        /// process, and a surviving server holds the port.
        pub fn start(&self, port: u16, password: &str) -> io::Result<()> {
            self.stop();
            self.shutting_down.store(false, Ordering::SeqCst);
            wsl::terminate();

            let gateway = wsl::host_gateway();
            let env = env_block(port, password, gateway.as_deref());
            let child = wsl::spawn_with_env(&env, ENTRYPOINT)?;
            *self.child.lock().unwrap() = Some(child);
            Ok(())
        }

        /// A live child whose port never answers is the expected
        /// localhost-forwarding failure, not a crash — callers report it as
        /// such.
        pub fn wait_healthy(&self, port: u16) -> Result<(), String> {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|e| e.to_string())?;
            let url = health_url(port);
            let deadline = Instant::now() + HEALTH_TIMEOUT;
            loop {
                if let Some(code) = self.exited() {
                    return Err(format!(
                        "The Cody runtime exited during startup (code {code})."
                    ));
                }
                if let Ok(response) = client.get(&url).send() {
                    if response.status().as_u16() < 500 {
                        return Ok(());
                    }
                }
                if Instant::now() >= deadline {
                    return Err(
                        "The runtime started but never answered on 127.0.0.1. This is usually \
                         WSL localhost forwarding dropping after sleep or resume."
                            .to_string(),
                    );
                }
                std::thread::sleep(HEALTH_INTERVAL);
            }
        }

        /// `Some(code)` once the child has exited; `None` while it is alive.
        pub fn exited(&self) -> Option<i32> {
            let mut guard = self.child.lock().unwrap();
            let child = guard.as_mut()?;
            match child.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                Ok(None) => None,
                Err(_) => Some(-1),
            }
        }

        pub fn is_shutting_down(&self) -> bool {
            self.shutting_down.load(Ordering::SeqCst)
        }

        /// Restart budget for an unexpected exit. Exponential, capped, and
        /// finite: a runtime that dies four times needs a human, not a loop.
        pub fn restart_backoff(attempt: u32) -> Option<Duration> {
            (attempt < MAX_RESTARTS).then(|| Duration::from_secs(1u64 << attempt))
        }

        pub fn stop(&self) {
            self.shutting_down.store(true, Ordering::SeqCst);
            if let Some(mut child) = self.child.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        /// Scoped to Cody's own distro. `wsl --shutdown` would kill every
        /// distro the user owns and is never called.
        pub fn shutdown(&self) {
            self.stop();
            wsl::terminate();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup<'a>(env: &'a [(&'static str, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn env_block_mirrors_the_dockerfile() {
        let env = env_block(30179, "secret", None);
        assert_eq!(lookup(&env, "HOME"), Some("/data/home"));
        assert_eq!(lookup(&env, "PI_CODING_AGENT_DIR"), Some("/data/agent"));
        assert_eq!(lookup(&env, "CODY_HARNESS"), Some("omp"));
        assert_eq!(lookup(&env, "CODY_CHROMIUM_BIN"), Some("/usr/bin/chromium"));
        assert_eq!(lookup(&env, "NODE_ENV"), Some("production"));
        assert_eq!(lookup(&env, "TERM"), Some("xterm-256color"));
        assert_eq!(lookup(&env, "PORT"), Some("30179"));
    }

    #[test]
    fn env_block_carries_the_desktop_only_values() {
        let env = env_block(30179, "s3cr3t", None);
        assert_eq!(lookup(&env, "CODY_PASSWORD"), Some("s3cr3t"));
        assert_eq!(lookup(&env, "CODY_REQUIRE_ACCOUNTS"), Some("1"));
        assert_eq!(lookup(&env, "CODY_DESKTOP"), Some("1"));
    }

    #[test]
    fn env_block_omits_the_gateway_when_undiscovered() {
        let env = env_block(30179, "s", None);
        assert_eq!(lookup(&env, "CODY_HOST_GATEWAY"), None);
        let env = env_block(30179, "s", Some("172.30.96.1"));
        assert_eq!(lookup(&env, "CODY_HOST_GATEWAY"), Some("172.30.96.1"));
    }

    #[test]
    fn env_block_never_sets_a_bind_host_wider_than_loopback() {
        let env = env_block(30179, "s", Some("172.30.96.1"));
        for (_, value) in &env {
            assert!(
                !value.contains("0.0.0.0"),
                "env block widened the bind host"
            );
        }
    }

    #[test]
    fn urls_are_loopback_only() {
        assert_eq!(
            health_url(30179),
            "http://127.0.0.1:30179/api/accounts/state"
        );
        assert_eq!(app_url(30179), "http://localhost:30179/");
    }
}
