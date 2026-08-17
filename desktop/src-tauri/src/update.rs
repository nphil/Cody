//! Shell self-update against the desktop release manifest.
//!
//! No signing-key infrastructure in v1: transport trust is TLS to
//! github.com, integrity is the sha256 in the manifest. The downloaded
//! installer is never executed unless its digest matches.

use serde::Deserialize;
use std::cmp::Ordering;

/// Baked at build time so a fork can point at its own releases;
/// `CODY_DESKTOP_MANIFEST_URL` is read by the build, not at runtime.
pub const MANIFEST_URL: &str = match option_env!("CODY_DESKTOP_MANIFEST_URL") {
    Some(url) => url,
    // The rolling desktop-latest tag, never /releases/latest — desktop
    // releases are prereleases, so "latest" belongs to the container train.
    None => "https://github.com/nphil/Cody/releases/download/desktop-latest/desktop-manifest.json",
};

pub const SHELL_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub version: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
    /// The source container image digest, for the runtime artifact. The
    /// version label is a poor freshness signal on its own: `:latest` is
    /// republished far more often than that label changes.
    #[serde(default)]
    pub image_digest: Option<String>,
}

impl Artifact {
    /// The markers a distro imported from this artifact reports back.
    pub fn markers(&self) -> InstalledRuntime {
        InstalledRuntime {
            version: Some(self.version.clone()),
            digest: self.image_digest.clone(),
        }
    }
}

/// Two independently-versioned artifacts, one release.
#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub shell: Option<Artifact>,
    pub runtime: Option<Artifact>,
}

pub fn parse_manifest(body: &str) -> Result<Manifest, String> {
    serde_json::from_str(body).map_err(|e| format!("Release manifest is malformed: {e}"))
}

/// Dotted numeric compare with a pre-release rule: `1.2.0-rc.1` precedes
/// `1.2.0`. Segments that are not numbers fall back to byte order, which is
/// enough for the `X.Y.Z[-tag]` shapes CI produces.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (a_core, a_pre) = split_prerelease(a);
    let (b_core, b_pre) = split_prerelease(b);

    let mut a_parts = a_core.split('.');
    let mut b_parts = b_core.split('.');
    loop {
        match (a_parts.next(), b_parts.next()) {
            (None, None) => break,
            (left, right) => {
                let left = left.unwrap_or("0");
                let right = right.unwrap_or("0");
                let ordering = match (left.parse::<u64>(), right.parse::<u64>()) {
                    (Ok(l), Ok(r)) => l.cmp(&r),
                    _ => left.cmp(right),
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
        }
    }

    match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(l), Some(r)) => l.cmp(r),
    }
}

fn split_prerelease(version: &str) -> (&str, Option<&str>) {
    let version = version.trim().trim_start_matches('v');
    match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    }
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) == Ordering::Greater
}

/// `None` when the installed shell is already current, or when the manifest
/// carries no shell entry at all.
pub fn newer_shell(manifest: &Manifest) -> Option<&Artifact> {
    manifest
        .shell
        .as_ref()
        .filter(|shell| is_newer(&shell.version, SHELL_VERSION))
}

/// What the installed distro says about itself: the two markers written into
/// it at import time. Either can be absent — a distro imported before that
/// marker existed simply reports `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InstalledRuntime {
    pub version: Option<String>,
    pub digest: Option<String>,
}

fn digests_differ(a: &str, b: &str) -> bool {
    !a.trim().eq_ignore_ascii_case(b.trim())
}

/// `None` when the installed runtime matches the manifest. A distro with no
/// version marker predates the marker and always counts as outdated.
///
/// Two independent signals, because neither covers the other: the version
/// catches a genuine Cody release, and the digest catches a `:latest`
/// republish that reused the same version label — which is most of them. The
/// digest only decides when both sides know theirs.
pub fn newer_runtime<'a>(
    manifest: &'a Manifest,
    installed: &InstalledRuntime,
) -> Option<&'a Artifact> {
    let runtime = manifest.runtime.as_ref()?;
    let Some(current) = installed.version.as_deref() else {
        return Some(runtime);
    };
    if is_newer(&runtime.version, current) {
        return Some(runtime);
    }
    match (installed.digest.as_deref(), runtime.image_digest.as_deref()) {
        (Some(have), Some(want)) => digests_differ(have, want).then_some(runtime),
        _ => None,
    }
}

/// The NSIS template kills a running instance under `/S`, so no delay shim
/// is needed; `/UPDATE` skips the uninstall pass and `/R` relaunches.
pub const INSTALLER_ARGS: &str = "/S /UPDATE /R";

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::config;
    use crate::win;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::Duration;

    fn client() -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            // GitHub rejects requests without a User-Agent.
            .user_agent(concat!("Cody-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())
    }

    pub fn fetch_manifest() -> Result<Manifest, String> {
        let body = client()?
            .get(MANIFEST_URL)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| format!("Could not reach the release manifest: {e}"))?;
        parse_manifest(&body)
    }

    /// Downloads, verifies, launches, and exits. Ordering matters: the
    /// installer is launched and only then does this process leave, and it
    /// is never waited on.
    pub fn apply(artifact: &Artifact) -> Result<(), String> {
        let dir = config::updates_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = artifact
            .url
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty() && !n.contains('\\'))
            .unwrap_or("cody-setup.exe");
        let installer: PathBuf = dir.join(name);

        let mut response = client()?
            .get(&artifact.url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Could not download the update: {e}"))?;
        let mut file = std::fs::File::create(&installer).map_err(|e| e.to_string())?;
        response
            .copy_to(&mut file)
            .map_err(|e| format!("Could not download the update: {e}"))?;
        file.flush().map_err(|e| e.to_string())?;
        drop(file);

        // Unsigned installer over TLS: the manifest digest is the only thing
        // standing between a hijacked download and code execution.
        let digest = crate::rootfs::sha256_file(&installer).map_err(|e| e.to_string())?;
        if !digest.eq_ignore_ascii_case(artifact.sha256.trim()) {
            let _ = std::fs::remove_file(&installer);
            return Err("The downloaded update failed its checksum and was discarded.".into());
        }

        win::shell_execute(&installer, INSTALLER_ARGS)?;
        std::process::exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_manifest() {
        let body = r#"{
          "shell":   { "version": "0.2.0", "url": "https://example.invalid/Cody_0.2.0_x64-setup.exe", "sha256": "AA" },
          "runtime": { "version": "1.4.2", "url": "https://example.invalid/rootfs.tar.gz", "sha256": "BB", "size": 1234 }
        }"#;
        let manifest = parse_manifest(body).expect("manifest should parse");
        let shell = manifest.shell.expect("shell entry");
        assert_eq!(shell.version, "0.2.0");
        assert_eq!(shell.sha256, "AA");
        let runtime = manifest.runtime.expect("runtime entry");
        assert_eq!(runtime.size, Some(1234));
    }

    #[test]
    fn parses_a_runtime_only_manifest() {
        let body = r#"{ "runtime": { "version": "1.4.2", "url": "u", "sha256": "b" } }"#;
        let manifest = parse_manifest(body).expect("manifest should parse");
        assert!(manifest.shell.is_none());
        assert!(manifest.runtime.is_some());
    }

    #[test]
    fn rejects_malformed_manifests() {
        assert!(parse_manifest("not json").is_err());
        assert!(parse_manifest(r#"{ "shell": { "version": "1.0.0" } }"#).is_err());
    }

    #[test]
    fn compares_numeric_segments_numerically() {
        assert_eq!(compare_versions("0.10.0", "0.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.3", "1.2.4"), Ordering::Less);
    }

    #[test]
    fn treats_missing_segments_as_zero() {
        assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.1", "1.2"), Ordering::Greater);
    }

    #[test]
    fn prerelease_sorts_below_its_release() {
        assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Ordering::Greater);
        assert_eq!(
            compare_versions("1.0.0-rc.2", "1.0.0-rc.1"),
            Ordering::Greater
        );
    }

    #[test]
    fn tolerates_a_leading_v() {
        assert_eq!(compare_versions("v1.3.0", "1.3.0"), Ordering::Equal);
        assert!(is_newer("v1.3.1", "1.3.0"));
    }

    #[test]
    fn is_newer_is_strict() {
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.9.0", "1.0.0"));
        assert!(is_newer("1.0.1", "1.0.0"));
    }

    #[test]
    fn installer_args_match_the_nsis_contract() {
        assert_eq!(INSTALLER_ARGS, "/S /UPDATE /R");
    }

    fn manifest_with_runtime(version: &str) -> Manifest {
        parse_manifest(&format!(
            r#"{{ "runtime": {{ "version": "{version}", "url": "u", "sha256": "d" }} }}"#
        ))
        .unwrap()
    }

    fn manifest_with_digest(version: &str, digest: &str) -> Manifest {
        parse_manifest(&format!(
            r#"{{ "runtime": {{ "version": "{version}", "url": "u", "sha256": "d",
                                "imageDigest": "{digest}" }} }}"#
        ))
        .unwrap()
    }

    fn installed(version: Option<&str>, digest: Option<&str>) -> InstalledRuntime {
        InstalledRuntime {
            version: version.map(str::to_owned),
            digest: digest.map(str::to_owned),
        }
    }

    #[test]
    fn a_runtime_without_a_marker_counts_as_outdated() {
        let manifest = manifest_with_runtime("1.4.2");
        assert!(newer_runtime(&manifest, &installed(None, None)).is_some());
    }

    #[test]
    fn a_matching_runtime_is_not_an_update() {
        let manifest = manifest_with_runtime("1.4.2");
        assert!(newer_runtime(&manifest, &installed(Some("1.4.2"), None)).is_none());
        assert!(newer_runtime(&manifest, &installed(Some("1.5.0"), None)).is_none());
        assert!(newer_runtime(&manifest, &installed(Some("1.4.1"), None)).is_some());
    }

    #[test]
    fn the_manifest_carries_the_runtime_image_digest() {
        let manifest = manifest_with_digest("1.4.2", "sha256:aa");
        assert_eq!(
            manifest.runtime.unwrap().image_digest.as_deref(),
            Some("sha256:aa")
        );
        // Absent in an older manifest rather than an error.
        assert!(manifest_with_runtime("1.4.2")
            .runtime
            .unwrap()
            .image_digest
            .is_none());
    }

    #[test]
    fn a_republished_image_at_the_same_version_is_an_update() {
        let manifest = manifest_with_digest("1.4.2", "sha256:bb");
        assert!(newer_runtime(&manifest, &installed(Some("1.4.2"), Some("sha256:aa"))).is_some());
        assert!(newer_runtime(&manifest, &installed(Some("1.4.2"), Some("sha256:bb"))).is_none());
        // Same image, different case or padding, is the same image.
        assert!(
            newer_runtime(&manifest, &installed(Some("1.4.2"), Some(" SHA256:BB\n"))).is_none()
        );
    }

    #[test]
    fn a_digest_known_on_only_one_side_decides_nothing() {
        // Distro imported before the digest marker existed.
        let manifest = manifest_with_digest("1.4.2", "sha256:bb");
        assert!(newer_runtime(&manifest, &installed(Some("1.4.2"), None)).is_none());
        // Manifest published before CI emitted the digest.
        let manifest = manifest_with_runtime("1.4.2");
        assert!(newer_runtime(&manifest, &installed(Some("1.4.2"), Some("sha256:aa"))).is_none());
    }

    #[test]
    fn a_newer_version_wins_whatever_the_digests_say() {
        let manifest = manifest_with_digest("1.5.0", "sha256:aa");
        assert!(newer_runtime(&manifest, &installed(Some("1.4.2"), Some("sha256:aa"))).is_some());
        // …and an older manifest is never offered, matching digests or not.
        let manifest = manifest_with_digest("1.4.0", "sha256:aa");
        assert!(newer_runtime(&manifest, &installed(Some("1.4.2"), Some("sha256:aa"))).is_none());
    }

    #[test]
    fn markers_carry_only_what_the_artifact_knows() {
        let artifact = manifest_with_digest("1.4.2", "sha256:aa").runtime.unwrap();
        assert_eq!(
            artifact.markers(),
            installed(Some("1.4.2"), Some("sha256:aa"))
        );
        let artifact = manifest_with_runtime("1.4.2").runtime.unwrap();
        assert_eq!(artifact.markers(), installed(Some("1.4.2"), None));
    }

    #[test]
    fn a_manifest_without_a_shell_entry_offers_no_shell_update() {
        assert!(newer_shell(&manifest_with_runtime("1.0.0")).is_none());
    }
}
