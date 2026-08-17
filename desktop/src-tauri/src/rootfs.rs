//! Runtime provisioning: download the rootfs, verify it, stream it into
//! `wsl --import`, and carry `/data` across a runtime replacement.

use sha2::{Digest, Sha256};
use std::io::Read;

/// Backups are `data-<unix seconds>.tar`; `<name>.restored` beside one records
/// that its contents are back inside a distro. Two generations are kept — they
/// are the size of the user's whole workspace.
pub const BACKUP_PREFIX: &str = "data-";
pub const BACKUP_SUFFIX: &str = ".tar";
pub const RESTORED_SUFFIX: &str = ".restored";
pub const BACKUPS_KEPT: usize = 2;

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn sha256_reader<R: Read>(mut reader: R) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

pub fn sha256_file(path: &std::path::Path) -> std::io::Result<String> {
    sha256_reader(std::fs::File::open(path)?)
}

pub fn digest_matches(actual: &str, expected: &str) -> bool {
    actual.trim().eq_ignore_ascii_case(expected.trim())
}

/// A ranged request answered with a 4xx — `416 Range Not Satisfiable` above
/// all — means the cached prefix cannot be continued: it is at least as long
/// as whatever is published under that URL now. Resuming can never recover
/// from it, so the file has to go.
pub fn range_rejected(status: u16, ranged: bool) -> bool {
    ranged && (400..500).contains(&status)
}

/// `rootfs-cody-1.4.2.tar.gz` -> `1.4.2`, the name CI publishes. Anything
/// else in the downloads folder is not a Cody rootfs.
pub fn archive_version(name: &str) -> Option<String> {
    let core = name.strip_prefix("rootfs-cody-")?.strip_suffix(".tar.gz")?;
    (!core.is_empty()).then(|| core.to_owned())
}

/// The highest-versioned cached rootfs that is not the one being installed —
/// what a failed update falls back to.
pub fn previous_archive(names: &[String], current: &str) -> Option<String> {
    names
        .iter()
        .filter(|name| name.as_str() != current)
        .filter_map(|name| Some((archive_version(name)?, name)))
        .max_by(|(a, _), (b, _)| crate::update::compare_versions(a, b))
        .map(|(_, name)| name.clone())
}

fn backup_timestamp(name: &str) -> Option<u64> {
    name.strip_prefix(BACKUP_PREFIX)?
        .strip_suffix(BACKUP_SUFFIX)?
        .parse()
        .ok()
}

fn backups_by_age(names: &[String]) -> Vec<(u64, &String)> {
    let mut backups: Vec<(u64, &String)> = names
        .iter()
        .filter_map(|name| Some((backup_timestamp(name)?, name)))
        .collect();
    backups.sort_by_key(|(stamp, _)| *stamp);
    backups
}

/// The newest backup nothing has unpacked yet — an update that died between
/// `--unregister` and a working distro leaves exactly one.
pub fn unrestored_backup(names: &[String]) -> Option<String> {
    backups_by_age(names)
        .into_iter()
        .rfind(|(_, name)| {
            let marker = format!("{name}{RESTORED_SUFFIX}");
            !names.contains(&marker)
        })
        .map(|(_, name)| name.clone())
}

/// Everything older than the `keep` newest backups, oldest first.
pub fn stale_backups(names: &[String], keep: usize) -> Vec<String> {
    let backups = backups_by_age(names);
    let cut = backups.len().saturating_sub(keep);
    backups[..cut]
        .iter()
        .map(|(_, name)| (*name).clone())
        .collect()
}

/// Reads through to an inner reader, reporting cumulative bytes. Used to give
/// the import phase real progress: the archive is measurable even though
/// `wsl --import` itself emits none.
pub struct CountingReader<R, F> {
    inner: R,
    read: u64,
    on_read: F,
}

impl<R: Read, F: FnMut(u64)> CountingReader<R, F> {
    pub fn new(inner: R, on_read: F) -> Self {
        Self {
            inner,
            read: 0,
            on_read,
        }
    }
}

impl<R: Read, F: FnMut(u64)> Read for CountingReader<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.read += n as u64;
            (self.on_read)(self.read);
        }
        Ok(n)
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::config;
    use crate::update::{Artifact, InstalledRuntime};
    use crate::wsl;
    use std::fs;
    use std::io::{Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn client() -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .timeout(None)
            .connect_timeout(Duration::from_secs(30))
            .user_agent(concat!("Cody-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())
    }

    pub fn archive_path(artifact: &Artifact) -> PathBuf {
        let name = artifact
            .url
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty() && !n.contains('\\'))
            .unwrap_or("cody-rootfs.tar.gz");
        config::downloads_dir().join(name)
    }

    enum Failed {
        /// The cached prefix is unusable; the caller drops it and restarts.
        StaleCache,
        Message(String),
    }

    impl Failed {
        /// A restart cannot report a stale cache again — it sends no Range —
        /// but the type still has to answer for that arm.
        fn message(self) -> String {
            match self {
                Failed::Message(message) => message,
                Failed::StaleCache => "Could not download the Cody runtime.".into(),
            }
        }
    }

    /// Resumable download. A partial file is continued with a Range request;
    /// a server that ignores Range answers 200 and the file restarts, which
    /// is correct rather than corrupt.
    pub fn download(
        artifact: &Artifact,
        dest: &Path,
        mut on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        // An already-complete download that verifies is reused as-is.
        if let Ok(existing) = sha256_file(dest) {
            if digest_matches(&existing, &artifact.sha256) {
                let len = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
                on_progress(len, Some(len));
                return Ok(());
            }
        }

        let have = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        match fetch(artifact, dest, have, &mut on_progress) {
            Ok(()) => Ok(()),
            // Restarting here, rather than surfacing the error, is what keeps
            // a Retry from looping forever against a file the server will
            // never accept a Range for.
            Err(Failed::StaleCache) => {
                let _ = fs::remove_file(dest);
                fetch(artifact, dest, 0, &mut on_progress).map_err(Failed::message)
            }
            Err(failed) => Err(failed.message()),
        }
    }

    fn fetch(
        artifact: &Artifact,
        dest: &Path,
        have: u64,
        on_progress: &mut impl FnMut(u64, Option<u64>),
    ) -> Result<(), Failed> {
        let mut request = client().map_err(Failed::Message)?.get(&artifact.url);
        if have > 0 {
            request = request.header("Range", format!("bytes={have}-"));
        }
        let response = request
            .send()
            .map_err(|e| Failed::Message(format!("Could not download the Cody runtime: {e}")))?;
        if range_rejected(response.status().as_u16(), have > 0) {
            return Err(Failed::StaleCache);
        }
        let mut response = response
            .error_for_status()
            .map_err(|e| Failed::Message(format!("Could not download the Cody runtime: {e}")))?;

        let resumed = response.status().as_u16() == 206;
        let remaining = response.content_length();
        let total = artifact
            .size
            .or_else(|| remaining.map(|r| if resumed { r + have } else { r }));

        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(!resumed)
            .open(dest)
            .map_err(|e| Failed::Message(e.to_string()))?;
        let mut written = if resumed {
            file.seek(SeekFrom::Start(have))
                .map_err(|e| Failed::Message(e.to_string()))?;
            have
        } else {
            0
        };

        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = response
                .read(&mut buf)
                .map_err(|e| Failed::Message(format!("The download was interrupted: {e}")))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .map_err(|e| Failed::Message(e.to_string()))?;
            written += n as u64;
            on_progress(written, total);
        }
        file.flush().map_err(|e| Failed::Message(e.to_string()))?;
        drop(file);

        let digest = sha256_file(dest).map_err(|e| Failed::Message(e.to_string()))?;
        if !digest_matches(&digest, &artifact.sha256) {
            // A bad digest may be a truncated resume; drop it so the retry
            // starts clean rather than resuming onto corruption.
            let _ = fs::remove_file(dest);
            return Err(Failed::Message(
                "The downloaded runtime failed its checksum and was discarded.".into(),
            ));
        }
        Ok(())
    }

    /// gzip is the format Microsoft recommends for WSL rootfs archives; the
    /// decompression happens here so `wsl --import` receives raw tar on
    /// stdin and no multi-gigabyte temp file is ever written.
    ///
    /// `markers` is what the imported distro will report back to the update
    /// check; whichever half of it is unknown is simply not written.
    pub fn import(
        archive: &Path,
        markers: &InstalledRuntime,
        mut on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(), String> {
        let dir = config::distro_dir();
        wsl::clear_failed_import(&dir).map_err(|e| e.to_string())?;
        wsl::clear_ntfs_attributes(&dir).map_err(|e| e.to_string())?;

        let total = fs::metadata(archive).map(|m| m.len()).ok();
        let file = fs::File::open(archive).map_err(|e| e.to_string())?;
        let counted = CountingReader::new(file, |read| on_progress(read, total));
        let decoder = flate2::read::GzDecoder::new(counted);

        wsl::import_streaming(&dir, decoder).map_err(|e| e.to_string())?;
        if let Some(version) = &markers.version {
            wsl::write_runtime_version(version).map_err(|e| e.to_string())?;
        }
        if let Some(digest) = &markers.digest {
            wsl::write_runtime_digest(digest).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// `/data` is the only stateful path, the same contract the container
    /// keeps. Export first: `--unregister` is irreversible.
    pub fn replace_runtime(
        archive: &Path,
        artifact: &Artifact,
        mut on_phase: impl FnMut(&str),
    ) -> Result<(), String> {
        let backup =
            config::backups_dir().join(format!("{BACKUP_PREFIX}{}{BACKUP_SUFFIX}", timestamp()));
        fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;

        on_phase("Backing up your Cody data…");
        wsl::terminate();
        {
            let file = fs::File::create(&backup).map_err(|e| e.to_string())?;
            wsl::exec_to_writer("tar -C /data -cf - .", file).map_err(|e| e.to_string())?;
        }

        on_phase("Replacing the Cody runtime…");
        wsl::unregister().map_err(|e| e.to_string())?;

        // Past the unregister there is no distro at all, so every way out of
        // this function either leaves one standing with `/data` back inside
        // it, or names the backup file in the error it returns.
        if let Err(failed) = import(archive, &artifact.markers(), |_, _| {}) {
            on_phase("Putting the Cody runtime back…");
            return recover(&backup, archive, artifact, &failed);
        }

        on_phase("Restoring your Cody data…");
        restore_backup(&backup).map_err(|message| orphaned(&backup, &message))?;
        prune_backups();
        Ok(())
    }

    /// The import failed with nothing registered. Import failures are often
    /// transient (a locked VHD, a half-written file), so the new rootfs gets
    /// a second attempt before the previous one is put back; either way the
    /// data goes in after whichever import lands.
    fn recover(
        backup: &Path,
        archive: &Path,
        artifact: &Artifact,
        failed: &str,
    ) -> Result<(), String> {
        if import(archive, &artifact.markers(), |_, _| {}).is_ok() {
            // The retry installed the runtime this update was for, so the
            // update itself is done.
            restore_backup(backup).map_err(|message| orphaned(backup, &message))?;
            prune_backups();
            return Ok(());
        }

        if let Some(previous) = previous_archive_path(archive) {
            let markers = InstalledRuntime {
                // Named after the version it holds, never the one that failed
                // to install — otherwise the update would look applied.
                version: file_name(&previous).and_then(|name| archive_version(&name)),
                digest: None,
            };
            if import(&previous, &markers, |_, _| {}).is_ok() {
                restore_backup(backup).map_err(|message| orphaned(backup, &message))?;
                return Err(format!(
                    "{failed}\n\nThe previous Cody runtime was reinstalled and your data \
                     restored, so nothing was lost — but the update was not applied."
                ));
            }
        }

        Err(orphaned(backup, failed))
    }

    /// Last resort: no distro, and the tar is the only copy of the user's
    /// data. Naming its absolute path is the whole point of this message.
    fn orphaned(backup: &Path, failed: &str) -> String {
        format!(
            "{failed}\n\nYour Cody data was backed up before the update and is still on disk at \
             {}. It will be restored automatically the next time the runtime is installed.",
            backup.display()
        )
    }

    /// Unpacks a backup and marks it restored. The marker is what stops a
    /// later fresh install from unpacking a backup that is already inside.
    fn restore_backup(backup: &Path) -> Result<(), String> {
        let file = fs::File::open(backup).map_err(|e| e.to_string())?;
        wsl::exec_from_reader("mkdir -p /data && tar -xf - -C /data", file)
            .map_err(|e| e.to_string())?;
        let _ = fs::write(marker_path(backup), "");
        Ok(())
    }

    /// A backup an update could not put back waits here for the fresh install
    /// that the same failure forces. Returns what was restored, if anything;
    /// the phase is only announced once there is something to announce.
    pub fn restore_pending_backup(
        mut on_phase: impl FnMut(&str),
    ) -> Result<Option<PathBuf>, String> {
        let dir = config::backups_dir();
        let Some(name) = unrestored_backup(&file_names(&dir)) else {
            return Ok(None);
        };
        on_phase("Restoring your Cody data…");
        let backup = dir.join(name);
        restore_backup(&backup)?;
        Ok(Some(backup))
    }

    fn prune_backups() {
        let dir = config::backups_dir();
        for name in stale_backups(&file_names(&dir), BACKUPS_KEPT) {
            let path = dir.join(name);
            let _ = fs::remove_file(marker_path(&path));
            let _ = fs::remove_file(&path);
        }
    }

    fn previous_archive_path(current: &Path) -> Option<PathBuf> {
        let dir = config::downloads_dir();
        let current = file_name(current)?;
        previous_archive(&file_names(&dir), &current).map(|name| dir.join(name))
    }

    fn marker_path(backup: &Path) -> PathBuf {
        let mut name = backup.file_name().unwrap_or_default().to_os_string();
        name.push(RESTORED_SUFFIX);
        backup.with_file_name(name)
    }

    fn file_name(path: &Path) -> Option<String> {
        path.file_name()?.to_str().map(str::to_owned)
    }

    fn file_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect()
    }

    fn timestamp() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_the_empty_input() {
        assert_eq!(
            sha256_reader(&b""[..]).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hashes_a_known_string() {
        assert_eq!(
            sha256_reader(&b"abc"[..]).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hex_pads_single_digit_bytes() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn digest_comparison_ignores_case_and_padding() {
        assert!(digest_matches("ABC123", "abc123"));
        assert!(digest_matches(" abc123\n", "abc123"));
        assert!(!digest_matches("abc123", "abc124"));
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| (*n).to_string()).collect()
    }

    #[test]
    fn a_rejected_range_is_only_a_rejected_range() {
        // 416 is the wedge this exists for: a cached file at least as long
        // as the asset now published under that URL.
        assert!(range_rejected(416, true));
        assert!(range_rejected(404, true));
        // Nothing was resumed, so there is no stale prefix to blame.
        assert!(!range_rejected(416, false));
        assert!(!range_rejected(404, false));
        // A served range, and a server that ignored the header outright.
        assert!(!range_rejected(206, true));
        assert!(!range_rejected(200, true));
        assert!(!range_rejected(503, true));
    }

    #[test]
    fn reads_the_version_out_of_a_rootfs_name() {
        assert_eq!(
            archive_version("rootfs-cody-1.4.2.tar.gz").as_deref(),
            Some("1.4.2")
        );
        assert_eq!(archive_version("rootfs-cody-.tar.gz"), None);
        assert_eq!(archive_version("cody-desktop-0.2.0-x64-setup.exe"), None);
        assert_eq!(archive_version("rootfs-cody-1.4.2.tar"), None);
    }

    #[test]
    fn the_previous_archive_is_the_newest_one_that_is_not_the_current() {
        let cached = names(&[
            "rootfs-cody-1.3.0.tar.gz",
            "rootfs-cody-1.4.2.tar.gz",
            "rootfs-cody-1.10.0.tar.gz",
            "notes.txt",
        ]);
        assert_eq!(
            previous_archive(&cached, "rootfs-cody-1.10.0.tar.gz").as_deref(),
            Some("rootfs-cody-1.4.2.tar.gz")
        );
        // Nothing else cached: the fallback simply is not available.
        let only = names(&["rootfs-cody-1.10.0.tar.gz"]);
        assert_eq!(previous_archive(&only, "rootfs-cody-1.10.0.tar.gz"), None);
        assert_eq!(previous_archive(&names(&["notes.txt"]), "x"), None);
    }

    #[test]
    fn an_unmarked_backup_is_the_one_to_restore() {
        let dir = names(&["data-100.tar", "data-100.tar.restored", "data-200.tar"]);
        assert_eq!(unrestored_backup(&dir).as_deref(), Some("data-200.tar"));

        // Newest first when several are pending.
        let dir = names(&["data-100.tar", "data-200.tar", "data-30.tar"]);
        assert_eq!(unrestored_backup(&dir).as_deref(), Some("data-200.tar"));
    }

    #[test]
    fn a_restored_backup_is_never_offered_again() {
        let dir = names(&["data-100.tar", "data-100.tar.restored"]);
        assert_eq!(unrestored_backup(&dir), None);
        assert_eq!(unrestored_backup(&names(&[])), None);
        assert_eq!(
            unrestored_backup(&names(&["rootfs-cody-1.0.0.tar.gz"])),
            None
        );
    }

    #[test]
    fn pruning_keeps_the_newest_backups() {
        let dir = names(&[
            "data-100.tar",
            "data-200.tar",
            "data-300.tar",
            "data-300.tar.restored",
            "data-90.tar",
            "readme.txt",
        ]);
        assert_eq!(
            stale_backups(&dir, BACKUPS_KEPT),
            vec!["data-90.tar".to_string(), "data-100.tar".to_string()]
        );
        // Fewer than the keep count: nothing to delete, and markers and
        // strays are never candidates.
        assert!(stale_backups(&names(&["data-100.tar", "readme.txt"]), 2).is_empty());
    }

    #[test]
    fn counting_reader_reports_cumulative_bytes() {
        let data = vec![7u8; 5000];
        let mut seen = Vec::new();
        let mut reader = CountingReader::new(&data[..], |n| seen.push(n));
        let mut sink = Vec::new();
        std::io::copy(&mut reader, &mut sink).unwrap();
        assert_eq!(sink.len(), 5000);
        assert_eq!(seen.last().copied(), Some(5000));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    }
}
