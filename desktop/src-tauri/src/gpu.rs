//! NVIDIA presence, for display in Settings alongside the local-runtime scan.
//! Absence is a normal answer, never an error.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Gpu {
    pub vendor: String,
    pub name: String,
    /// Megabytes, as `nvidia-smi` reports them with `nounits`.
    pub vram_mb: Option<u64>,
    pub driver: Option<String>,
}

pub const QUERY_ARGS: [&str; 2] = [
    "--query-gpu=name,memory.total,driver_version",
    "--format=csv,noheader,nounits",
];

/// Parses the first row of `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`.
/// Multi-GPU machines report the first adapter: the shell shows presence, not
/// an inventory.
pub fn parse_query(output: &str) -> Option<Gpu> {
    let line = output.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut fields = line.split(',').map(str::trim);
    let name = fields.next().filter(|n| !n.is_empty())?;
    let vram_mb = fields.next().and_then(|v| v.parse::<u64>().ok());
    let driver = fields.next().filter(|d| !d.is_empty()).map(str::to_owned);
    Some(Gpu {
        vendor: "NVIDIA".to_string(),
        name: name.to_string(),
        vram_mb,
        driver,
    })
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    /// There is no single standard install path for `nvidia-smi.exe`; these
    /// are the three that modern and legacy driver packages use.
    fn candidates() -> Vec<PathBuf> {
        let windir = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));

        let mut paths = vec![
            // Same non-native-process caveat as wsl.exe.
            windir.join("Sysnative").join("nvidia-smi.exe"),
            windir.join("System32").join("nvidia-smi.exe"),
            program_files
                .join("NVIDIA Corporation")
                .join("NVSMI")
                .join("nvidia-smi.exe"),
        ];

        let repository = windir
            .join("System32")
            .join("DriverStore")
            .join("FileRepository");
        if let Ok(entries) = std::fs::read_dir(&repository) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().starts_with("nvdm") {
                    paths.push(entry.path().join("nvidia-smi.exe"));
                }
            }
        }
        paths
    }

    pub fn detect() -> Option<Gpu> {
        let exe = candidates().into_iter().find(|p| p.exists())?;
        let output = Command::new(exe)
            .args(QUERY_ARGS)
            .creation_flags(crate::wsl::CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        // nvidia-smi emits ASCII/UTF-8, not wsl.exe's UTF-16LE.
        parse_query(&String::from_utf8_lossy(&output.stdout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_row() {
        let gpu = parse_query("NVIDIA GeForce RTX 4080, 16376, 566.36\n").expect("a gpu");
        assert_eq!(gpu.vendor, "NVIDIA");
        assert_eq!(gpu.name, "NVIDIA GeForce RTX 4080");
        assert_eq!(gpu.vram_mb, Some(16376));
        assert_eq!(gpu.driver.as_deref(), Some("566.36"));
    }

    #[test]
    fn takes_the_first_adapter_only() {
        let gpu = parse_query("GPU A, 8192, 1.0\nGPU B, 4096, 1.0\n").expect("a gpu");
        assert_eq!(gpu.name, "GPU A");
    }

    #[test]
    fn tolerates_missing_columns() {
        let gpu = parse_query("NVIDIA T1000\n").expect("a gpu");
        assert_eq!(gpu.vram_mb, None);
        assert_eq!(gpu.driver, None);
    }

    #[test]
    fn unparsable_memory_is_dropped_not_guessed() {
        let gpu = parse_query("NVIDIA T1000, [N/A], 1.0\n").expect("a gpu");
        assert_eq!(gpu.vram_mb, None);
    }

    #[test]
    fn no_output_means_no_gpu() {
        assert_eq!(parse_query(""), None);
        assert_eq!(parse_query("\n  \n"), None);
    }
}
