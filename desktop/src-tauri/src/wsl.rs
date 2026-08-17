//! `wsl.exe` driving: probe-based detection, distro lifecycle, streaming import.
//!
//! Two rules govern everything here. `wsl.exe` has no documented exit-code
//! contract and localizes its prose, so state is decided by probing and by
//! matching hex HRESULTs. And `wsl.exe` emits *its own* output as UTF-16LE
//! unless `WSL_UTF8=1` is set, while output passed through from inside a
//! distro is raw UTF-8 — one binary, two encodings, so every read is sniffed.

use crate::status::FailureKind;

/// Namespaced so Cody never touches a distro it does not own.
pub const DISTRO: &str = "cody";

/// Written into the rootfs at import time; the update check compares it with
/// the release manifest.
pub const RUNTIME_VERSION_PATH: &str = "/etc/cody-runtime-version";

/// The digest of the container image the rootfs was flattened from, written
/// beside the version marker. It is what catches a `:latest` republish that
/// left the version label untouched.
pub const RUNTIME_DIGEST_PATH: &str = "/etc/cody-runtime-digest";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    /// `wsl.exe` is not present at all.
    NoBinary,
    /// The optional Windows component is not enabled (`0x8007019e`).
    FeatureDisabled,
    /// Virtualization is off in UEFI, or the CPU lacks SLAT (`0x80370102`).
    VirtualizationDisabled,
    /// The WSL2 kernel package is missing or stale.
    KernelOutdated,
    /// The install location is not on the system drive (`0x80070003`).
    NotSystemDrive,
    /// WSL answered, but the command failed for a reason we cannot name.
    Unknown,
}

impl Problem {
    pub fn kind(self) -> FailureKind {
        match self {
            Problem::NoBinary => FailureKind::WslMissing,
            Problem::FeatureDisabled => FailureKind::WslFeatureDisabled,
            Problem::VirtualizationDisabled => FailureKind::VirtualizationDisabled,
            Problem::KernelOutdated => FailureKind::WslKernelOutdated,
            Problem::NotSystemDrive => FailureKind::NotSystemDrive,
            Problem::Unknown => FailureKind::Unknown,
        }
    }
}

/// Decode a byte stream that may be `wsl.exe`'s own UTF-16LE output or a
/// Linux process's UTF-8 passthrough. `WSL_UTF8=1` is set on every child, but
/// it is a silent no-op on older WSL builds, so the sniff stays.
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16le(rest);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    // UTF-16LE-encoded ASCII carries a NUL at nearly every odd index.
    let n = bytes.len().min(64);
    if n >= 4 {
        let odd = (1..n).step_by(2).count();
        let nuls = (1..n).step_by(2).filter(|&i| bytes[i] == 0).count();
        if nuls * 4 >= odd * 3 {
            return utf16le(bytes);
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .trim_start_matches('\u{feff}')
        .replace('\u{0}', "")
}

/// Classify a failure from decoded `wsl.exe` output. Hex HRESULTs only —
/// every prose string `wsl.exe` prints is localized, and the two exact
/// English strings matched here are the documented fallbacks for builds that
/// print no code at all.
pub fn classify(text: &str) -> Problem {
    let lower = text.to_ascii_lowercase();
    if lower.contains("0x8007019e") {
        return Problem::FeatureDisabled;
    }
    if lower.contains("0x80370102") {
        return Problem::VirtualizationDisabled;
    }
    if lower.contains("0x80070003") {
        return Problem::NotSystemDrive;
    }
    if lower.contains("0x800701bc") || lower.contains("requires an update to its kernel component")
    {
        return Problem::KernelOutdated;
    }
    if lower.contains("is not recognized") {
        return Problem::FeatureDisabled;
    }
    Problem::Unknown
}

/// Parse `wsl --list --quiet`. `--quiet` suppresses the localized header, so
/// every non-empty line is a distro name.
pub fn parse_distro_list(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.trim().trim_end_matches('\r').trim())
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn list_has_distro(text: &str, name: &str) -> bool {
    parse_distro_list(text)
        .iter()
        .any(|d| d.eq_ignore_ascii_case(name))
}

/// Extract the Windows host address from `ip route show default` run inside
/// the distro. `/etc/resolv.conf` is not a substitute: with DNS tunnelling on
/// it holds `10.255.255.254`, a tunnel endpoint rather than the gateway.
pub fn parse_default_gateway(text: &str) -> Option<String> {
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        if fields.next() != Some("default") {
            continue;
        }
        if fields.next() != Some("via") {
            continue;
        }
        if let Some(addr) = fields.next() {
            if !addr.is_empty() {
                return Some(addr.to_owned());
            }
        }
    }
    None
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::OsStr;
    use std::io::{self, Read, Write};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};

    /// Without this every `wsl.exe` call flashes a console window.
    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[derive(Debug)]
    pub enum Error {
        Io(io::Error),
        Wsl { problem: Problem, output: String },
    }

    impl std::fmt::Display for Error {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Error::Io(e) => write!(f, "{e}"),
                Error::Wsl { output, .. } => write!(f, "{}", output.trim()),
            }
        }
    }

    impl From<io::Error> for Error {
        fn from(e: io::Error) -> Self {
            Error::Io(e)
        }
    }

    impl Error {
        pub fn problem(&self) -> Problem {
            match self {
                Error::Io(_) => Problem::Unknown,
                Error::Wsl { problem, .. } => *problem,
            }
        }
    }

    pub type Result<T> = std::result::Result<T, Error>;

    /// `Sysnative` is a virtual alias that exists **only** for non-native
    /// processes (WOW64, or x64 emulated on ARM64); for a native process it
    /// is absent. Probing for it therefore doubles as the nativeness test,
    /// and `wsl.exe` is always invoked by absolute path so PowerShell's
    /// ARM64 alias problems never apply.
    pub fn wsl_exe() -> PathBuf {
        let windir = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let sysnative = windir.join("Sysnative").join("wsl.exe");
        if sysnative.exists() {
            return sysnative;
        }
        windir.join("System32").join("wsl.exe")
    }

    fn wsl() -> Command {
        let mut c = Command::new(wsl_exe());
        c.creation_flags(CREATE_NO_WINDOW);
        c.env("WSL_UTF8", "1");
        c
    }

    fn run(args: &[&OsStr]) -> Result<String> {
        let out = wsl()
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;
        let stdout = decode_wsl_output(&out.stdout);
        if out.status.success() {
            return Ok(stdout);
        }
        let stderr = decode_wsl_output(&out.stderr);
        let combined = format!("{stdout}\n{stderr}");
        Err(Error::Wsl {
            problem: classify(&combined),
            output: combined,
        })
    }

    fn args<'a>(list: &'a [&'a str]) -> Vec<&'a OsStr> {
        list.iter().map(|s| OsStr::new(*s)).collect()
    }

    /// Probe order per the WSL research: binary present, then a modern-WSL
    /// discriminator, then the status page where the HRESULTs surface.
    pub fn probe() -> std::result::Result<(), Problem> {
        if !wsl_exe().exists() {
            return Err(Problem::NoBinary);
        }
        // Legacy inbox WSL treats `--version` as an invalid argument and
        // dumps help, which is the cleanest single discriminator for
        // "modern Store/OSS WSL".
        if let Err(e) = run(&args(&["--version"])) {
            return Err(match e.problem() {
                Problem::Unknown => Problem::KernelOutdated,
                other => other,
            });
        }
        match run(&args(&["--status"])) {
            Ok(_) => Ok(()),
            Err(e) => Err(e.problem()),
        }
    }

    pub fn distro_exists() -> Result<bool> {
        let listed = run(&args(&["--list", "--quiet"]))?;
        Ok(list_has_distro(&listed, DISTRO))
    }

    pub fn terminate() {
        // Best effort: a distro that is not running is not an error worth
        // surfacing, and this runs before every launch to clear orphans.
        let _ = run(&args(&["--terminate", DISTRO]));
    }

    /// Irreversible. Every caller must have taken a backup first.
    pub fn unregister() -> Result<()> {
        run(&args(&["--unregister", DISTRO])).map(|_| ())
    }

    /// Maintenance commands touch `/etc` and root-owned files under `/data`,
    /// so they never depend on whatever default user the rootfs declares.
    fn distro_args(command: &str, as_root: bool) -> Vec<&str> {
        let mut args = vec!["-d", DISTRO];
        if as_root {
            args.extend(["-u", "root"]);
        }
        args.extend(["--", "sh", "-lc", command]);
        args
    }

    /// Run a command inside the distro and capture its stdout.
    pub fn exec_capture(command: &str) -> Result<String> {
        exec_capture_inner(command, false)
    }

    pub fn exec_capture_as_root(command: &str) -> Result<String> {
        exec_capture_inner(command, true)
    }

    fn exec_capture_inner(command: &str, as_root: bool) -> Result<String> {
        let out = wsl()
            .args(distro_args(command, as_root))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;
        if out.status.success() {
            // Passthrough from Linux is raw UTF-8; the sniff is harmless.
            return Ok(decode_wsl_output(&out.stdout));
        }
        let combined = format!(
            "{}\n{}",
            decode_wsl_output(&out.stdout),
            decode_wsl_output(&out.stderr)
        );
        Err(Error::Wsl {
            problem: classify(&combined),
            output: combined,
        })
    }

    /// Spawn a long-running child inside the distro with an explicit env
    /// block. `docker export` strips image ENV, so the shell owns it.
    pub fn spawn_with_env(env_pairs: &[(&str, String)], command: &str) -> io::Result<Child> {
        let mut cmd = wsl();
        cmd.args(["-d", DISTRO, "--", "env"]);
        for (key, value) in env_pairs {
            cmd.arg(format!("{key}={value}"));
        }
        cmd.args(["sh", "-lc", command]);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }

    /// Stream a tar into `wsl --import`. Callers hand over a reader that
    /// decompresses on the fly, so a multi-gigabyte temp file never exists.
    pub fn import_streaming<R: Read>(dir: &Path, mut source: R) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let mut child = wsl()
            .args(["--import", DISTRO])
            .arg(dir)
            .args(["-", "--version", "2"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let copy = io::copy(&mut source, &mut stdin);
        // EOF is what tells wsl.exe the archive is complete.
        drop(stdin);
        let out = child.wait_with_output()?;
        copy?;
        if out.status.success() {
            return Ok(());
        }
        let combined = format!(
            "{}\n{}",
            decode_wsl_output(&out.stdout),
            decode_wsl_output(&out.stderr)
        );
        Err(Error::Wsl {
            problem: classify(&combined),
            output: combined,
        })
    }

    /// Pipe a command's stdout inside the distro into a writer (`tar -cf -`).
    pub fn exec_to_writer<W: Write>(command: &str, mut sink: W) -> Result<()> {
        let mut child = wsl()
            .args(distro_args(command, true))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let copied = io::copy(&mut stdout, &mut sink);
        let out = child.wait_with_output()?;
        copied?;
        if out.status.success() {
            return Ok(());
        }
        let text = decode_wsl_output(&out.stderr);
        Err(Error::Wsl {
            problem: classify(&text),
            output: text,
        })
    }

    /// Feed a reader into a command's stdin inside the distro (`tar -xf -`).
    pub fn exec_from_reader<R: Read>(command: &str, mut source: R) -> Result<()> {
        let mut child = wsl()
            .args(distro_args(command, true))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let copied = io::copy(&mut source, &mut stdin);
        drop(stdin);
        let out = child.wait_with_output()?;
        copied?;
        if out.status.success() {
            return Ok(());
        }
        let text = decode_wsl_output(&out.stderr);
        Err(Error::Wsl {
            problem: classify(&text),
            output: text,
        })
    }

    const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x0000_0800;
    const FILE_ATTRIBUTE_ENCRYPTED: u32 = 0x0000_4000;

    /// NTFS compression and encryption both corrupt WSL VHDs ("virtual hard
    /// disk files must be uncompressed and unencrypted"). Users hit this by
    /// compressing all of `AppData` on small SSDs, and the failure is silent
    /// and late, so the attributes are cleared before every import. Done via
    /// the inbox tools rather than `DeviceIoControl` to keep the unsafe
    /// surface of this crate at DPAPI and `ShellExecuteW`.
    pub fn clear_ntfs_attributes(dir: &Path) -> io::Result<()> {
        use std::os::windows::fs::MetadataExt;

        std::fs::create_dir_all(dir)?;
        let attrs = std::fs::metadata(dir)?.file_attributes();
        let windir = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));

        if attrs & FILE_ATTRIBUTE_ENCRYPTED != 0 {
            let _ = Command::new(windir.join("System32").join("cipher.exe"))
                .arg("/D")
                .arg(dir)
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        if attrs & FILE_ATTRIBUTE_COMPRESSED != 0 {
            let _ = Command::new(windir.join("System32").join("compact.exe"))
                .args(["/U", "/S", "/I", "/Q"])
                .arg(dir)
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        Ok(())
    }

    /// The Windows host address as seen from the distro. Resolved live: it
    /// changes across reboots, so it is never cached to disk.
    pub fn host_gateway() -> Option<String> {
        exec_capture("ip route show default")
            .ok()
            .as_deref()
            .and_then(parse_default_gateway)
    }

    pub fn read_runtime_version() -> Option<String> {
        read_marker(RUNTIME_VERSION_PATH)
    }

    pub fn read_runtime_digest() -> Option<String> {
        read_marker(RUNTIME_DIGEST_PATH)
    }

    /// Both markers in one probe, in the shape the update check consumes.
    pub fn read_installed_runtime() -> crate::update::InstalledRuntime {
        crate::update::InstalledRuntime {
            version: read_runtime_version(),
            digest: read_runtime_digest(),
        }
    }

    fn read_marker(path: &str) -> Option<String> {
        let raw = exec_capture(&format!("cat {path} 2>/dev/null")).ok()?;
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    }

    pub fn write_runtime_version(version: &str) -> Result<()> {
        write_marker(RUNTIME_VERSION_PATH, version)
    }

    pub fn write_runtime_digest(digest: &str) -> Result<()> {
        write_marker(RUNTIME_DIGEST_PATH, digest)
    }

    fn write_marker(path: &str, value: &str) -> Result<()> {
        // Single-quoted so a manifest value can never break out into sh.
        let escaped = value.replace('\'', "");
        exec_capture_as_root(&format!("printf '%s' '{escaped}' > {path}")).map(|_| ())
    }

    /// A killed import leaves a partial `ext4.vhdx` that blocks every retry,
    /// and `--import` refuses a directory it did not create.
    pub fn clear_failed_import(dir: &Path) -> io::Result<()> {
        if dir.join("ext4.vhdx").exists() {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16_bytes(s: &str, bom: bool) -> Vec<u8> {
        let mut out = Vec::new();
        if bom {
            out.extend_from_slice(&[0xFF, 0xFE]);
        }
        for unit in s.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn decodes_utf16_with_bom() {
        let bytes = utf16_bytes("Windows Subsystem for Linux\r\n", true);
        assert_eq!(decode_wsl_output(&bytes), "Windows Subsystem for Linux\r\n");
    }

    #[test]
    fn decodes_utf16_without_bom_by_sniffing() {
        let bytes = utf16_bytes("WSL version: 2.9.4.0\r\n", false);
        assert_eq!(decode_wsl_output(&bytes), "WSL version: 2.9.4.0\r\n");
    }

    #[test]
    fn decodes_utf8_passthrough() {
        assert_eq!(
            decode_wsl_output(b"ready on 127.0.0.1\n"),
            "ready on 127.0.0.1\n"
        );
    }

    #[test]
    fn decodes_utf8_with_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("cody\n".as_bytes());
        assert_eq!(decode_wsl_output(&bytes), "cody\n");
    }

    #[test]
    fn decodes_non_ascii_utf8_without_mistaking_it_for_utf16() {
        assert_eq!(decode_wsl_output("日本語のログ".as_bytes()), "日本語のログ");
    }

    #[test]
    fn empty_input_decodes_to_empty() {
        assert_eq!(decode_wsl_output(b""), "");
    }

    #[test]
    fn classifies_feature_disabled() {
        let text = "Error: 0x8007019e The Windows Subsystem for Linux optional \
                    component is not enabled.";
        assert_eq!(classify(text), Problem::FeatureDisabled);
    }

    #[test]
    fn classifies_virtualization_disabled() {
        assert_eq!(
            classify("Error code: Wsl/Service/CreateInstance/CreateVm/HCS/0x80370102"),
            Problem::VirtualizationDisabled
        );
    }

    #[test]
    fn classifies_non_system_drive() {
        assert_eq!(
            classify("Installation failed with error 0x80070003"),
            Problem::NotSystemDrive
        );
    }

    #[test]
    fn classifies_kernel_update_from_prose() {
        assert_eq!(
            classify("WSL 2 requires an update to its kernel component."),
            Problem::KernelOutdated
        );
    }

    #[test]
    fn classifies_uppercase_hresult() {
        assert_eq!(classify("Error: 0x8007019E"), Problem::FeatureDisabled);
    }

    #[test]
    fn unknown_output_stays_unknown() {
        assert_eq!(classify("Something went sideways"), Problem::Unknown);
    }

    #[test]
    fn parses_quiet_distro_list() {
        let listed = "Ubuntu\r\ncody\r\ndocker-desktop\r\n";
        assert_eq!(
            parse_distro_list(listed),
            vec!["Ubuntu", "cody", "docker-desktop"]
        );
        assert!(list_has_distro(listed, "cody"));
        assert!(!list_has_distro(listed, "codyx"));
    }

    #[test]
    fn distro_match_ignores_case() {
        assert!(list_has_distro("CODY\n", "cody"));
    }

    #[test]
    fn parses_default_gateway() {
        let route = "default via 172.30.96.1 dev eth0 proto kernel\n\
                     172.30.96.0/20 dev eth0 proto kernel scope link src 172.30.101.5\n";
        assert_eq!(parse_default_gateway(route).as_deref(), Some("172.30.96.1"));
    }

    #[test]
    fn missing_default_route_yields_none() {
        assert_eq!(parse_default_gateway("172.30.96.0/20 dev eth0\n"), None);
    }
}
